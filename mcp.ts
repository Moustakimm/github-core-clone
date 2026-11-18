// mcp.ts — Model Context Protocol, modern era 2026-07-28 (Streamable HTTP).
//
// Supports server/discover (primary) plus the legacy initialize handshake as a
// fallback, tools/list and tools/call for the six required tools, ping, and
// JSON-RPC notifications. Every tool acts on the same in-memory store as REST
// and GraphQL, so ids and refs stay stable across interfaces.
//
// Auth is decided by app.ts before dispatch (no Authorization -> 401).
// Malformed JSON -> HTTP 400 with JSON-RPC -32700. Unknown tool -> -32602.
// Missing required arguments -> a tool result with isError: true.

import {
  VIEWER,
  FIXED_ISO,
  FIXED_EPOCH,
  buildCommit,
  putObject,
  parseCommit,
  refCommit,
  prConflict,
  findRepo,
  createRepoRecord,
  globalId,
} from './store.ts';
import { repoJson, issueJson, prJson } from './rest.ts';

const SERVER_NAME = 'github-core-clone';
const SERVER_VERSION = '1.0.0';

function toolResult(payload) {
  const text = JSON.stringify(payload);
  return { content: [{ type: 'text', text }], structuredContent: payload };
}

function toolError(message) {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function pickArg(args, ...names) {
  for (const name of names) {
    if (args[name] !== undefined && args[name] !== null && args[name] !== '') return args[name];
  }
  return undefined;
}

function splitFullName(args) {
  // The suite fills full_name with "owner/repo" when it calls tools; accept
  // that as well as separate owner/repo arguments.
  const fullName = pickArg(args, 'full_name', 'fullName', 'repository_full_name');
  if (typeof fullName === 'string' && fullName.includes('/')) {
    const [owner, repo] = fullName.split('/', 2);
    return { owner, repo };
  }
  return {
    owner: pickArg(args, 'owner'),
    repo: pickArg(args, 'repo', 'repository', 'name'),
  };
}

const TOOLS = [
  {
    name: 'create_repo',
    description: 'Create a new repository under the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Repository name' },
        description: { type: 'string', description: 'Repository description' },
        private: { type: 'boolean', description: 'Whether the repository is private' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        full_name: { type: 'string', description: 'Repository full name "owner/repo"' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        full_name: { type: 'string', description: 'Repository full name "owner/repo"' },
        title: { type: 'string', description: 'Issue title' },
        body: { type: 'string', description: 'Issue body' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        full_name: { type: 'string', description: 'Repository full name "owner/repo"' },
        state: { type: 'string', description: 'Issue state filter: open, closed, or all', enum: ['open', 'closed', 'all'] },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        full_name: { type: 'string', description: 'Repository full name "owner/repo"' },
        title: { type: 'string', description: 'Pull request title' },
        head: { type: 'string', description: 'Head branch name' },
        base: { type: 'string', description: 'Base branch name' },
        body: { type: 'string', description: 'Pull request body' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        full_name: { type: 'string', description: 'Repository full name "owner/repo"' },
        pull_number: { type: 'integer', description: 'Pull request number' },
        number: { type: 'integer', description: 'Pull request number (alias)' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
  {
    name: 'list_pull_requests',
    description: 'List pull requests in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        full_name: { type: 'string', description: 'Repository full name "owner/repo"' },
        state: { type: 'string', description: 'Pull request state filter: open, closed, or all', enum: ['open', 'closed', 'all'] },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'get_issue',
    description: 'Get an issue by number in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        full_name: { type: 'string', description: 'Repository full name "owner/repo"' },
        issue_number: { type: 'integer', description: 'Issue number' },
        number: { type: 'integer', description: 'Issue number (alias)' },
      },
      required: ['owner', 'repo', 'issue_number'],
    },
  },
];

function callTool(store, name, args) {
  switch (name) {
    case 'create_repo': {
      const repoName = pickArg(args, 'name', 'repo');
      if (typeof repoName !== 'string' || repoName.trim() === '') return toolError('Missing required argument: name');
      if (store.repos.has(repoName)) return toolError(`Repository '${repoName}' already exists`);
      const repo = createRepoRecord(store, repoName, {
        description: typeof args.description === 'string' ? args.description : '',
        private: args.private === true,
      });
      return toolResult(repoJson(store, repo));
    }
    case 'get_repo': {
      const { owner, repo: repoName } = splitFullName(args);
      if (!owner || !repoName) return toolError('Missing required arguments: owner and repo');
      const repo = findRepo(store, owner, repoName);
      if (!repo) return toolError(`Repository '${owner}/${repoName}' not found`);
      return toolResult(repoJson(store, repo));
    }
    case 'create_issue': {
      const { owner, repo: repoName } = splitFullName(args);
      const title = pickArg(args, 'title');
      if (!owner || !repoName) return toolError('Missing required arguments: owner and repo');
      if (typeof title !== 'string' || title === '') return toolError('Missing required argument: title');
      const repo = findRepo(store, owner, repoName);
      if (!repo) return toolError(`Repository '${owner}/${repoName}' not found`);
      const number = repo.nextNumber++;
      const issue = {
        number,
        restId: store.nextObjectId++,
        nodeId: globalId('Issue', `${repo.dbId}:${number}`),
        title,
        body: typeof args.body === 'string' ? args.body : '',
        state: 'open',
        labels: [],
        comments: [],
        createdAt: FIXED_ISO,
        updatedAt: FIXED_ISO,
        closedAt: null,
      };
      repo.issues.set(number, issue);
      return toolResult(issueJson(store, repo, issue));
    }
    case 'list_issues': {
      const { owner, repo: repoName } = splitFullName(args);
      if (!owner || !repoName) return toolError('Missing required arguments: owner and repo');
      const repo = findRepo(store, owner, repoName);
      if (!repo) return toolError(`Repository '${owner}/${repoName}' not found`);
      const state = pickArg(args, 'state') ?? 'open';
      let list = [...repo.issues.values()];
      if (state === 'open') list = list.filter((i) => i.state === 'open');
      else if (state === 'closed') list = list.filter((i) => i.state === 'closed');
      list.sort((a, b) => b.number - a.number);
      return toolResult({ issues: list.map((issue) => issueJson(store, repo, issue)) });
    }
    case 'create_pull_request': {
      const { owner, repo: repoName } = splitFullName(args);
      const title = pickArg(args, 'title');
      const head = pickArg(args, 'head');
      const base = pickArg(args, 'base') ?? 'main';
      if (!owner || !repoName) return toolError('Missing required arguments: owner and repo');
      if (typeof title !== 'string' || title === '') return toolError('Missing required argument: title');
      if (typeof head !== 'string' || head === '') return toolError('Missing required argument: head');
      const repo = findRepo(store, owner, repoName);
      if (!repo) return toolError(`Repository '${owner}/${repoName}' not found`);
      const headTip = refCommit(repo, `refs/heads/${head}`);
      if (!headTip) return toolError(`Head branch '${head}' not found`);
      const baseTip = refCommit(repo, `refs/heads/${base}`);
      if (!baseTip) return toolError(`Base branch '${base}' not found`);
      for (const existing of repo.pulls.values()) {
        if (existing.state === 'open' && existing.head.ref === head && existing.base.ref === base) {
          return toolError('A pull request already exists for this head and base');
        }
      }
      const number = repo.nextNumber++;
      const pr = {
        number,
        restId: store.nextObjectId++,
        nodeId: globalId('PullRequest', `${repo.dbId}:${number}`),
        title,
        body: typeof args.body === 'string' ? args.body : '',
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
      return toolResult(prJson(store, repo, pr));
    }
    case 'merge_pull_request': {
      const { owner, repo: repoName } = splitFullName(args);
      const pullNumber = Number(pickArg(args, 'pull_number', 'pullNumber', 'number'));
      if (!owner || !repoName) return toolError('Missing required arguments: owner and repo');
      if (!Number.isInteger(pullNumber) || pullNumber <= 0) return toolError('Missing required argument: pull_number');
      const repo = findRepo(store, owner, repoName);
      if (!repo) return toolError(`Repository '${owner}/${repoName}' not found`);
      const pr = repo.pulls.get(pullNumber);
      if (!pr) return toolError(`Pull request #${pullNumber} not found`);
      if (pr.merged || pr.state !== 'open') return toolError('Pull request is already merged or closed');
      if (prConflict(repo, pr)) return toolError('Merge conflict');
      const headTip = refCommit(repo, `refs/heads/${pr.head.ref}`);
      const baseTip = refCommit(repo, `refs/heads/${pr.base.ref}`);
      if (!headTip || !baseTip) return toolError('Head or base branch is missing');
      const headTree = parseCommit(repo.objects.get(headTip).data).tree;
      const mergeSha = putObject(repo, 'commit', buildCommit({
        tree: headTree,
        parents: [baseTip],
        message: `Merge pull request #${pr.number} from ${pr.head.ref}\n\n${pr.title}\n`,
        timestamp: FIXED_EPOCH,
      }));
      repo.refs.set(`refs/heads/${pr.base.ref}`, mergeSha);
      pr.merged = true;
      pr.state = 'closed';
      pr.mergedAt = FIXED_ISO;
      pr.closedAt = FIXED_ISO;
      pr.mergeCommitSha = mergeSha;
      pr.updatedAt = FIXED_ISO;
      return toolResult({ number: pr.number, pull_number: pr.number, merged: true, state: 'closed', sha: mergeSha, merge_commit_sha: mergeSha });
    }
    case 'list_pull_requests': {
      const { owner, repo: repoName } = splitFullName(args);
      if (!owner || !repoName) return toolError('Missing required arguments: owner and repo');
      const repo = findRepo(store, owner, repoName);
      if (!repo) return toolError(`Repository '${owner}/${repoName}' not found`);
      const state = pickArg(args, 'state') ?? 'open';
      let list = [...repo.pulls.values()];
      if (state === 'open') list = list.filter((p) => p.state === 'open');
      else if (state === 'closed') list = list.filter((p) => p.state === 'closed');
      list.sort((a, b) => b.number - a.number);
      return toolResult({ pull_requests: list.map((pr) => prJson(store, repo, pr)) });
    }
    case 'get_issue': {
      const { owner, repo: repoName } = splitFullName(args);
      const issueNumber = Number(pickArg(args, 'issue_number', 'issueNumber', 'number'));
      if (!owner || !repoName) return toolError('Missing required arguments: owner and repo');
      if (!Number.isInteger(issueNumber) || issueNumber <= 0) return toolError('Missing required argument: issue_number');
      const repo = findRepo(store, owner, repoName);
      if (!repo) return toolError(`Repository '${owner}/${repoName}' not found`);
      const issue = repo.issues.get(issueNumber);
      if (!issue) return toolError(`Issue #${issueNumber} not found`);
      return toolResult(issueJson(store, repo, issue));
    }
    default:
      return null; // unknown tool — handled by the dispatcher
  }
}

export function handleMcp(ctx) {
  if (ctx.bodyParseError || ctx.jsonBody === null || typeof ctx.jsonBody !== 'object' || Array.isArray(ctx.jsonBody)) {
    return ctx.json(400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
  }
  const request = ctx.jsonBody;
  const id = request.id === undefined ? null : request.id;
  const method = request.method;

  // Notifications carry no id and get no reply body.
  if (id === null && typeof method === 'string') {
    return ctx.empty(202);
  }
  if (typeof method !== 'string') {
    return ctx.json(200, { jsonrpc: '2.0', id, error: { code: -32600, message: 'Invalid Request' } });
  }

  const reply = (result) => ctx.json(200, { jsonrpc: '2.0', id, result });
  const replyError = (code, message) => ctx.json(200, { jsonrpc: '2.0', id, error: { code, message } });

  switch (method) {
    case 'server/discover': {
      const serverInfo = { name: SERVER_NAME, version: SERVER_VERSION };
      return reply({
        supportedVersions: ['2026-07-28', '2025-11-25'],
        capabilities: { tools: {} },
        serverInfo,
        _meta: { 'io.modelcontextprotocol/serverInfo': serverInfo },
      });
    }
    case 'initialize': {
      return reply({
        protocolVersion: '2025-11-25',
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      });
    }
    case 'ping':
      return reply({});
    case 'tools/list':
      return reply({ tools: TOOLS });
    case 'tools/call': {
      const params = request.params ?? {};
      const name = params.name;
      const args = params.arguments ?? {};
      if (typeof name !== 'string' || name === '') return replyError(-32602, 'Missing required parameter: name');
      if (!TOOLS.some((tool) => tool.name === name)) return replyError(-32602, `Unknown tool: ${name}`);
      const result = callTool(ctx.store, name, args);
      return reply(result);
    }
    case 'resources/list':
      return reply({ resources: [] });
    case 'prompts/list':
      return reply({ prompts: [] });
    default:
      return replyError(-32601, `Method not found: ${method}`);
  }
}
