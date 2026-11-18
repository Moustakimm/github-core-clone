// graphql.ts — a small, dependency-free GraphQL executor for the fixed set of
// documents the conformance suite sends. Not a general GraphQL server: it
// parses operations, aliases, variables, enums, inline input objects/lists,
// inline fragments and __type introspection, then resolves against the same
// in-memory store as REST.
//
// Rules honoured: global ids are opaque base64; unknown repo -> data.repository
// null with no errors; unknown field -> HTTP 200 with an errors entry naming
// the field; batched requests (JSON array) -> array of results in order.

import {
  VIEWER,
  FIXED_ISO,
  FIXED_EPOCH,
  buildCommit,
  putObject,
  parseCommit,
  refCommit,
  mergeBase,
  diffTrees,
  prConflict,
  findRepo,
  globalId,
  decodeGlobalId,
} from './store.ts';

// ---------------------------------------------------------------------------
// Tokenizer + parser
// ---------------------------------------------------------------------------

function tokenize(src) {
  const tokens = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') { i += 1; continue; }
    if (ch === '#') { while (i < src.length && src[i] !== '\n') i += 1; continue; }
    if (ch === '{' || ch === '}' || ch === '(' || ch === ')' || ch === ':' || ch === '$' || ch === '!' || ch === '[' || ch === ']' || ch === '=' || ch === '@') {
      tokens.push({ type: ch, value: ch }); i += 1; continue;
    }
    if (src.startsWith('...', i)) { tokens.push({ type: '...', value: '...' }); i += 3; continue; }
    if (ch === '"') {
      if (src.startsWith('"""', i)) {
        const end = src.indexOf('"""', i + 3);
        if (end === -1) throw new Error('unterminated block string');
        tokens.push({ type: 'string', value: src.slice(i + 3, end) });
        i = end + 3; continue;
      }
      let j = i + 1;
      let out = '';
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\\') {
          const esc = src[j + 1];
          const map = { n: '\n', t: '\t', r: '\r', '"': '"', '\\': '\\', '/': '/' };
          if (esc === 'u') { out += String.fromCharCode(Number.parseInt(src.slice(j + 2, j + 6), 16)); j += 6; }
          else { out += map[esc] ?? esc; j += 2; }
        } else { out += src[j]; j += 1; }
      }
      if (j >= src.length) throw new Error('unterminated string');
      tokens.push({ type: 'string', value: out });
      i = j + 1; continue;
    }
    if (/[0-9]/.test(ch) || (ch === '-' && /[0-9]/.test(src[i + 1] ?? ''))) {
      let j = i;
      while (j < src.length && /[0-9.eE+-]/.test(src[j])) j += 1;
      const raw = src.slice(i, j);
      const num = Number(raw);
      if (!Number.isFinite(num)) throw new Error(`bad number ${raw}`);
      tokens.push({ type: 'number', value: num });
      i = j; continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j])) j += 1;
      tokens.push({ type: 'name', value: src.slice(i, j) });
      i = j; continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)}`);
  }
  tokens.push({ type: 'EOF', value: '' });
  return tokens;
}

class Parser {
  constructor(tokens) { this.tokens = tokens; this.pos = 0; }
  peek() { return this.tokens[this.pos]; }
  next() { return this.tokens[this.pos++]; }
  expect(type, what) {
    const token = this.next();
    if (token.type !== type) throw new Error(`expected ${what ?? type}, got ${token.type} ${JSON.stringify(token.value)}`);
    return token;
  }
  skipDirectives() {
    while (this.peek().type === '@') {
      this.next();
      this.expect('name');
      if (this.peek().type === '(') this.parseArguments();
    }
  }
  parseDocument() {
    const operations = [];
    const fragments = new Map();
    while (this.peek().type !== 'EOF') {
      if (this.peek().type === 'name' && this.peek().value === 'fragment') {
        this.next();
        const name = this.expect('name').value;
        this.expect('name'); // 'on'
        const typeCondition = this.expect('name').value;
        this.skipDirectives();
        const selections = this.parseSelectionSet();
        fragments.set(name, { typeCondition, selections });
      } else {
        let operation = 'query';
        let name = null;
        if (this.peek().type === 'name' && (this.peek().value === 'query' || this.peek().value === 'mutation' || this.peek().value === 'subscription')) {
          operation = this.next().value;
        }
        if (this.peek().type === 'name') name = this.next().value;
        let variables = [];
        if (this.peek().type === '(') variables = this.parseVariableDefinitions();
        this.skipDirectives();
        const selections = this.parseSelectionSet();
        operations.push({ operation, name, variables, selections });
      }
    }
    return { operations, fragments };
  }
  parseVariableDefinitions() {
    this.expect('(');
    const defs = [];
    while (this.peek().type !== ')') {
      this.expect('$');
      const name = this.expect('name').value;
      this.expect(':');
      const type = this.parseType();
      let defaultValue = undefined;
      if (this.peek().type === '=') { this.next(); defaultValue = this.parseValue(); }
      this.skipDirectives();
      defs.push({ name, type, defaultValue });
    }
    this.expect(')');
    return defs;
  }
  parseType() {
    let type;
    if (this.peek().type === '[') {
      this.next();
      const inner = this.parseType();
      this.expect(']');
      type = { kind: 'list', ofType: inner };
    } else {
      type = { kind: 'named', name: this.expect('name').value };
    }
    if (this.peek().type === '!') { this.next(); type = { kind: 'nonNull', ofType: type }; }
    return type;
  }
  parseSelectionSet() {
    this.expect('{');
    const selections = [];
    while (this.peek().type !== '}') {
      selections.push(this.parseSelection());
    }
    this.expect('}');
    return selections;
  }
  parseSelection() {
    if (this.peek().type === '...') {
      this.next();
      if (this.peek().type === 'name' && this.peek().value === 'on') {
        this.next();
        const typeCondition = this.expect('name').value;
        this.skipDirectives();
        return { kind: 'inlineFragment', typeCondition, selections: this.parseSelectionSet() };
      }
      const name = this.expect('name').value;
      this.skipDirectives();
      return { kind: 'fragmentSpread', name };
    }
    let alias = null;
    let name = this.expect('name').value;
    if (this.peek().type === ':') {
      this.next();
      alias = name;
      name = this.expect('name').value;
    }
    let args = new Map();
    if (this.peek().type === '(') args = this.parseArguments();
    this.skipDirectives();
    let selections = null;
    if (this.peek().type === '{') selections = this.parseSelectionSet();
    return { kind: 'field', name, alias: alias ?? name, args, selections };
  }
  parseArguments() {
    this.expect('(');
    const args = new Map();
    while (this.peek().type !== ')') {
      const name = this.expect('name').value;
      this.expect(':');
      args.set(name, this.parseValue());
    }
    this.expect(')');
    return args;
  }
  parseValue() {
    const token = this.next();
    if (token.type === '$') return { kind: 'variable', name: this.expect('name').value };
    if (token.type === 'string') return { kind: 'string', value: token.value };
    if (token.type === 'number') return { kind: 'number', value: token.value };
    if (token.type === '[') {
      const values = [];
      while (this.peek().type !== ']') values.push(this.parseValue());
      this.expect(']');
      return { kind: 'list', values };
    }
    if (token.type === '{') {
      const fields = new Map();
      while (this.peek().type !== '}') {
        const name = this.expect('name').value;
        this.expect(':');
        fields.set(name, this.parseValue());
      }
      this.expect('}');
      return { kind: 'object', fields };
    }
    if (token.type === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null', value: null };
      return { kind: 'enum', value: token.value };
    }
    throw new Error(`unexpected value token ${token.type}`);
  }
}

function evalValue(node, variables) {
  switch (node.kind) {
    case 'variable': return variables[node.name];
    case 'list': return node.values.map((v) => evalValue(v, variables));
    case 'object': {
      const out = {};
      for (const [key, value] of node.fields) out[key] = evalValue(value, variables);
      return out;
    }
    default: return node.value;
  }
}

function evalArgs(field, variables) {
  const out = {};
  for (const [key, node] of field.args) out[key] = evalValue(node, variables);
  return out;
}

// ---------------------------------------------------------------------------
// Static introspection model
// ---------------------------------------------------------------------------

const TYPE_FIELDS = {
  Issue: ['id', 'number', 'title', 'state', 'body', 'createdAt', 'updatedAt', 'closedAt', 'author', 'url', 'databaseId'],
  PullRequest: ['id', 'number', 'title', 'state', 'body', 'headRefName', 'baseRefName', 'mergeable', 'merged', 'mergeCommit', 'files', 'createdAt', 'updatedAt', 'closedAt', 'author', 'url', 'databaseId'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest'],
  User: ['id', 'login', 'name', 'email', 'databaseId'],
  Ref: ['name', 'prefix', 'target'],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestFileConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  IssueEdge: ['node', 'cursor'],
  PullRequestEdge: ['node', 'cursor'],
  PullRequestFileEdge: ['node', 'cursor'],
  PageInfo: ['hasNextPage', 'endCursor', 'hasPreviousPage', 'startCursor'],
  IssueComment: ['id', 'body', 'author', 'createdAt', 'updatedAt', 'url'],
  IssueCommentEdge: ['node', 'cursor'],
  PullRequestFile: ['path'],
  Commit: ['oid', 'message'],
  Query: ['viewer', 'repository', 'node', '__type', '__schema'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  CreateIssuePayload: ['issue', 'clientMutationId'],
  CloseIssuePayload: ['issue', 'clientMutationId'],
  CreatePullRequestPayload: ['pullRequest', 'clientMutationId'],
  MergePullRequestPayload: ['pullRequest', 'clientMutationId'],
  AddCommentPayload: ['commentEdge', 'clientMutationId'],
  __Type: ['kind', 'name', 'fields', 'enumValues', 'description'],
  __Field: ['name', 'description', 'args', 'type', 'isDeprecated', 'deprecationReason'],
  __EnumValue: ['name', 'description', 'isDeprecated', 'deprecationReason'],
  __InputValue: ['name', 'description', 'type', 'defaultValue'],
};

const ENUM_VALUES = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
};

function encodeCursor(index) {
  return Buffer.from(`cursor:${index}`, 'utf8').toString('base64');
}
function decodeCursor(cursor) {
  try {
    const text = Buffer.from(String(cursor), 'base64').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(text);
    return match ? Number(match[1]) : -1;
  } catch { return -1; }
}

// ---------------------------------------------------------------------------
// Object wrappers (carry __typename so inline fragments resolve)
// ---------------------------------------------------------------------------

function repoObj(repo) { return { __typename: 'Repository', __repo: repo }; }
function issueObj(repo, issue) { return { __typename: 'Issue', __repo: repo, __issue: issue }; }
function prObj(repo, pr) { return { __typename: 'PullRequest', __repo: repo, __pr: pr }; }
function userObj() { return { __typename: 'User' }; }
function refObj(repo, name) { return { __typename: 'Ref', __repo: repo, __name: name }; }
function commentObj(repo, issue, comment) { return { __typename: 'IssueComment', __repo: repo, __issue: issue, __comment: comment }; }
function fileObj(path) { return { __typename: 'PullRequestFile', __path: path }; }

function connectionObj(kind, nodes, pageInfo, totalCount) {
  return { __typename: kind, __nodes: nodes, __pageInfo: pageInfo, __totalCount: totalCount };
}
function pageInfoObj(hasNextPage, endCursor) {
  return { __typename: 'PageInfo', __hasNextPage: hasNextPage, __endCursor: endCursor };
}

function findRepoByDbId(store, dbId) {
  for (const repo of store.repos.values()) if (repo.dbId === dbId) return repo;
  return null;
}
function findIssueByGlobalId(store, gid) {
  const decoded = decodeGlobalId(gid);
  if (!decoded || decoded.kind !== 'Issue') return null;
  const [dbId, number] = decoded.rest;
  const repo = findRepoByDbId(store, Number(dbId));
  if (!repo) return null;
  const issue = repo.issues.get(Number(number));
  return issue ? { repo, issue } : null;
}
function findPrByGlobalId(store, gid) {
  const decoded = decodeGlobalId(gid);
  if (!decoded || decoded.kind !== 'PullRequest') return null;
  const [dbId, number] = decoded.rest;
  const repo = findRepoByDbId(store, Number(dbId));
  if (!repo) return null;
  const pr = repo.pulls.get(Number(number));
  return pr ? { repo, pr } : null;
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

class Executor {
  constructor(store) {
    this.store = store;
    this.errors = [];
  }

  run(document, variables, operationName) {
    let operation = document.operations[0];
    if (operationName) {
      const named = document.operations.find((op) => op.name === operationName);
      if (named) operation = named;
    }
    if (!operation) return { data: null, errors: [{ message: 'No operation found' }] };
    const vars = { ...variables };
    for (const def of operation.variables) {
      if (vars[def.name] === undefined && def.defaultValue !== undefined) {
        vars[def.name] = evalValue(def.defaultValue, vars);
      }
    }
    const isMutation = operation.operation === 'mutation';
    const rootType = isMutation ? 'Mutation' : 'Query';
    const root = { __typename: rootType };
    const data = this.executeSelections(rootType, root, operation.selections, vars, document.fragments);
    const out = { data };
    if (this.errors.length > 0) out.errors = this.errors;
    return out;
  }

  executeSelections(typeName, obj, selections, vars, fragments) {
    // The object's own __typename wins: inline fragments like
    // `... on Repository` inside `node { ... }` resolve against Repository.
    const effectiveType = obj.__typename ?? typeName;
    const result = {};
    for (const selection of selections) {
      if (selection.kind === 'inlineFragment') {
        if (!selection.typeCondition || selection.typeCondition === obj.__typename) {
          Object.assign(result, this.executeSelections(effectiveType, obj, selection.selections, vars, fragments));
        }
        continue;
      }
      if (selection.kind === 'fragmentSpread') {
        const fragment = fragments.get(selection.name);
        if (fragment) {
          if (!fragment.typeCondition || fragment.typeCondition === obj.__typename) {
            Object.assign(result, this.executeSelections(effectiveType, obj, fragment.selections, vars, fragments));
          }
        }
        continue;
      }
      // field
      const value = this.resolveField(effectiveType, obj, selection, vars, fragments);
      result[selection.alias] = value;
    }
    return result;
  }

  // Resolve one field; returns the JSON value (recursing into sub-selections).
  resolveField(typeName, obj, field, vars, fragments) {
    const args = evalArgs(field, vars);
    if (field.name === '__typename') return obj.__typename ?? typeName;

    const known = TYPE_FIELDS[typeName];
    if (known && !known.includes(field.name)) {
      this.errors.push({ message: `Cannot query field "${field.name}" on type "${typeName}".` });
      return null;
    }
    const value = this.fieldValue(typeName, obj, field.name, args);
    if (value === undefined) {
      this.errors.push({ message: `Cannot query field "${field.name}" on type "${typeName}".` });
      return null;
    }
    if (!field.selections) return value;
    if (value === null) return null;
    if (Array.isArray(value)) {
      // A list of objects (connection nodes already carry __typename).
      return value.map((item) => {
        if (item && typeof item === 'object' && item.__typename) {
          return this.executeSelections(item.__typename, item, field.selections, vars, fragments);
        }
        return item;
      });
    }
    if (typeof value === 'object' && value.__typename) {
      return this.executeSelections(value.__typename, value, field.selections, vars, fragments);
    }
    return value;
  }

  fieldValue(typeName, obj, name, args) {
    const store = this.store;
    switch (typeName) {
      case 'Query': return this.queryField(obj, name, args);
      case 'Mutation': return this.mutationField(obj, name, args);
      case 'User': return this.userField(name);
      case 'Repository': return this.repositoryField(obj, name, args);
      case 'Issue': return this.issueField(obj, name);
      case 'PullRequest': return this.pullRequestField(obj, name, args);
      case 'Ref': return this.refField(obj, name);
      case 'IssueConnection':
      case 'PullRequestConnection':
      case 'PullRequestFileConnection': return this.connectionField(obj, name);
      case 'IssueEdge':
      case 'PullRequestEdge':
      case 'PullRequestFileEdge':
      case 'IssueCommentEdge': return this.edgeField(obj, name);
      case 'PageInfo': return obj[name === 'hasNextPage' ? '__hasNextPage' : '__endCursor'];
      case 'IssueComment': return this.commentField(obj, name);
      case 'PullRequestFile': return name === 'path' ? obj.__path : undefined;
      case 'Commit': return name === 'oid' ? obj.__oid : name === 'message' ? obj.__message.replace(/\n$/, '') : undefined;
      case 'CreateIssuePayload':
      case 'CloseIssuePayload': return this.payloadField(obj, name, 'issue');
      case 'CreatePullRequestPayload':
      case 'MergePullRequestPayload': return this.payloadField(obj, name, 'pullRequest');
      case 'AddCommentPayload': return this.payloadField(obj, name, 'commentEdge');
      case '__Type': return this.introspectionTypeField(obj, name, args);
      case '__Field': return this.introspectionFieldField(obj, name);
      case '__EnumValue': return this.introspectionEnumField(obj, name);
      case '__InputValue': return undefined;
      default: return undefined;
    }
  }

  queryField(_obj, name, args) {
    if (name === 'viewer') return userObj();
    if (name === 'repository') {
      const repo = findRepo(this.store, args.owner, args.name);
      return repo ? repoObj(repo) : null;
    }
    if (name === 'node') {
      const gid = args.id;
      if (typeof gid !== 'string') return null;
      const decoded = decodeGlobalId(gid);
      if (!decoded) return null;
      if (decoded.kind === 'Repository') {
        const repo = findRepoByDbId(this.store, Number(decoded.rest[0]));
        return repo ? repoObj(repo) : null;
      }
      if (decoded.kind === 'Issue') {
        const found = findIssueByGlobalId(this.store, gid);
        return found ? issueObj(found.repo, found.issue) : null;
      }
      if (decoded.kind === 'PullRequest') {
        const found = findPrByGlobalId(this.store, gid);
        return found ? prObj(found.repo, found.pr) : null;
      }
      return null;
    }
    if (name === '__type') {
      const typeName = args.name;
      if (typeof typeName !== 'string') return null;
      if (TYPE_FIELDS[typeName] || ENUM_VALUES[typeName]) {
        return { __typename: '__Type', __typeName: typeName };
      }
      return null;
    }
    if (name === '__schema') return { __typename: '__Schema' };
    return undefined;
  }

  userField(name) {
    switch (name) {
      case 'id': return globalId('User', VIEWER.id);
      case 'login': return VIEWER.login;
      case 'name': return VIEWER.name;
      case 'email': return VIEWER.email;
      case 'databaseId': return VIEWER.id;
      default: return undefined;
    }
  }

  repositoryField(obj, name, args) {
    const repo = obj.__repo;
    switch (name) {
      case 'id': return repo.nodeId;
      case 'databaseId': return repo.dbId;
      case 'name': return repo.name;
      case 'nameWithOwner': return `${repo.owner}/${repo.name}`;
      case 'owner': return userObj();
      case 'defaultBranchRef': {
        const tip = refCommit(repo, `refs/heads/${repo.defaultBranch}`);
        return tip ? refObj(repo, repo.defaultBranch) : null;
      }
      case 'viewerPermission': return 'ADMIN';
      case 'hasIssuesEnabled': return true;
      case 'issue': {
        const issue = repo.issues.get(Number(args.number));
        return issue ? issueObj(repo, issue) : null;
      }
      case 'issues': return this.issuesConnection(repo, args);
      case 'pullRequest': {
        const pr = repo.pulls.get(Number(args.number));
        return pr ? prObj(repo, pr) : null;
      }
      case 'pullRequests': return this.pullsConnection(repo, args);
      default: return undefined;
    }
  }

  issuesConnection(repo, args) {
    let list = [...repo.issues.values()];
    if (Array.isArray(args.states) && args.states.length > 0) {
      const wanted = new Set(args.states.map((s) => String(s).toLowerCase()));
      list = list.filter((issue) => wanted.has(issue.state));
    }
    const direction = args.orderBy?.direction === 'ASC' ? 'asc' : 'desc';
    list.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
    return this.paginate(list.map((issue) => issueObj(repo, issue)), args, 'IssueConnection');
  }

  pullsConnection(repo, args) {
    let list = [...repo.pulls.values()];
    if (Array.isArray(args.states) && args.states.length > 0) {
      const wanted = new Set(args.states.map((s) => String(s).toUpperCase()));
      list = list.filter((pr) => wanted.has(pr.state === 'open' ? 'OPEN' : pr.merged ? 'MERGED' : 'CLOSED'));
    }
    const direction = args.orderBy?.direction === 'ASC' ? 'asc' : 'desc';
    list.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
    return this.paginate(list.map((pr) => prObj(repo, pr)), args, 'PullRequestConnection');
  }

  paginate(nodes, args, kind) {
    const first = typeof args.first === 'number' && args.first >= 0 ? Math.trunc(args.first) : nodes.length;
    let start = 0;
    if (typeof args.after === 'string' && args.after !== '') {
      const idx = decodeCursor(args.after);
      if (idx >= 0) start = idx + 1;
    }
    const page = nodes.slice(start, start + first);
    const hasNextPage = start + first < nodes.length;
    const endCursor = page.length > 0 ? encodeCursor(start + page.length - 1) : null;
    return connectionObj(kind, page, pageInfoObj(hasNextPage, endCursor), nodes.length);
  }

  issueField(obj, name) {
    const issue = obj.__issue;
    switch (name) {
      case 'id': return issue.nodeId;
      case 'number': return issue.number;
      case 'title': return issue.title;
      case 'body': return issue.body;
      case 'state': return issue.state === 'open' ? 'OPEN' : 'CLOSED';
      case 'databaseId': return issue.number;
      case 'createdAt': return issue.createdAt;
      case 'updatedAt': return issue.updatedAt;
      case 'closedAt': return issue.closedAt;
      case 'author': return userObj();
      case 'url': return `https://example.invalid/${obj.__repo.owner}/${obj.__repo.name}/issues/${issue.number}`;
      default: return undefined;
    }
  }

  pullRequestField(obj, name, args) {
    const repo = obj.__repo;
    const pr = obj.__pr;
    switch (name) {
      case 'id': return pr.nodeId;
      case 'number': return pr.number;
      case 'title': return pr.title;
      case 'body': return pr.body;
      case 'state': return pr.state === 'open' ? 'OPEN' : pr.merged ? 'MERGED' : 'CLOSED';
      case 'headRefName': return pr.head.ref;
      case 'baseRefName': return pr.base.ref;
      case 'mergeable': {
        if (pr.merged || pr.state !== 'open') return 'UNKNOWN';
        return prConflict(repo, pr) ? 'CONFLICTING' : 'MERGEABLE';
      }
      case 'merged': return pr.merged;
      case 'mergeCommit': {
        if (!pr.mergeCommitSha) return null;
        const commit = parseCommit(repo.objects.get(pr.mergeCommitSha).data);
        return { __typename: 'Commit', __oid: pr.mergeCommitSha, __message: commit.message };
      }
      case 'files': {
        const files = this.prFiles(repo, pr);
        return this.paginate(files.map((f) => fileObj(f.path)), args, 'PullRequestFileConnection');
      }
      case 'databaseId': return pr.number;
      case 'createdAt': return pr.createdAt;
      case 'updatedAt': return pr.updatedAt;
      case 'closedAt': return pr.closedAt;
      case 'author': return userObj();
      case 'url': return `https://example.invalid/${repo.owner}/${repo.name}/pull/${pr.number}`;
      default: return undefined;
    }
  }

  prFiles(repo, pr) {
    const headTip = refCommit(repo, `refs/heads/${pr.head.ref}`);
    const baseTip = refCommit(repo, `refs/heads/${pr.base.ref}`);
    if (!headTip || !baseTip) return [];
    const base = mergeBase(repo, headTip, baseTip) ?? pr.baseShaAtCreate;
    const baseTree = base ? parseCommit(repo.objects.get(base).data).tree : null;
    const headTree = parseCommit(repo.objects.get(headTip).data).tree;
    return diffTrees(repo, baseTree, headTree);
  }

  refField(obj, name) {
    switch (name) {
      case 'name': return obj.__name;
      case 'prefix': return 'refs/heads/';
      case 'target': {
        const tip = refCommit(obj.__repo, `refs/heads/${obj.__name}`);
        if (!tip) return null;
        const commit = parseCommit(obj.__repo.objects.get(tip).data);
        return { __typename: 'Commit', __oid: tip, __message: commit.message };
      }
      default: return undefined;
    }
  }

  connectionField(obj, name) {
    switch (name) {
      case 'nodes': return obj.__nodes;
      case 'edges': {
        return obj.__nodes.map((node, i) => ({
          __typename: obj.__typename.replace('Connection', 'Edge'),
          __node: node,
          __cursor: encodeCursor(i),
        }));
      }
      case 'pageInfo': return obj.__pageInfo;
      case 'totalCount': return obj.__totalCount;
      default: return undefined;
    }
  }

  edgeField(obj, name) {
    if (name === 'node') return obj.__node;
    if (name === 'cursor') return obj.__cursor;
    return undefined;
  }

  commentField(obj, name) {
    const comment = obj.__comment;
    switch (name) {
      case 'id': return comment.nodeId;
      case 'body': return comment.body;
      case 'author': return userObj();
      case 'createdAt': return comment.createdAt;
      case 'updatedAt': return comment.updatedAt;
      case 'url': return `https://example.invalid/${obj.__repo.owner}/${obj.__repo.name}/issues/${obj.__issue.number}#issuecomment-${comment.restId}`;
      default: return undefined;
    }
  }

  payloadField(obj, name, key) {
    if (name === key) return obj[`__${key}`] ?? null;
    if (name === 'clientMutationId') return obj.__clientMutationId ?? null;
    return undefined;
  }

  introspectionTypeField(obj, name, args) {
    const typeName = obj.__typeName;
    switch (name) {
      case 'kind': return ENUM_VALUES[typeName] ? 'ENUM' : 'OBJECT';
      case 'name': return typeName;
      case 'description': return null;
      case 'fields': {
        const fields = TYPE_FIELDS[typeName] ?? [];
        return fields.map((fieldName) => ({ __typename: '__Field', __name: fieldName, __typeName: typeName }));
      }
      case 'enumValues': {
        const values = ENUM_VALUES[typeName] ?? [];
        return values.map((value) => ({ __typename: '__EnumValue', __name: value }));
      }
      default: return undefined;
    }
  }

  introspectionFieldField(obj, name) {
    switch (name) {
      case 'name': return obj.__name;
      case 'description': return null;
      case 'args': return [];
      case 'type': return { __typename: '__Type', __typeName: 'String' };
      case 'isDeprecated': return false;
      case 'deprecationReason': return null;
      default: return undefined;
    }
  }

  introspectionEnumField(obj, name) {
    switch (name) {
      case 'name': return obj.__name;
      case 'description': return null;
      case 'isDeprecated': return false;
      case 'deprecationReason': return null;
      default: return undefined;
    }
  }

  // -- Mutations (same store semantics as REST) ----------------------------

  mutationField(_obj, name, args) {
    const input = args.input ?? {};
    switch (name) {
      case 'createIssue': return this.createIssue(input);
      case 'closeIssue': return this.closeIssue(input);
      case 'createPullRequest': return this.createPullRequest(input);
      case 'mergePullRequest': return this.mergePullRequest(input);
      case 'addComment': return this.addComment(input);
      default: return undefined;
    }
  }

  createIssue(input) {
    const decoded = decodeGlobalId(input.repositoryId);
    const repo = decoded?.kind === 'Repository' ? findRepoByDbId(this.store, Number(decoded.rest[0])) : null;
    if (!repo || typeof input.title !== 'string' || input.title === '') {
      this.errors.push({ message: 'Could not resolve to a Repository with the provided id.' });
      return { __typename: 'CreateIssuePayload', __issue: null, __clientMutationId: input.clientMutationId ?? null };
    }
    const number = repo.nextNumber++;
    const issue = {
      number,
      restId: this.store.nextObjectId++,
      nodeId: globalId('Issue', `${repo.dbId}:${number}`),
      title: input.title,
      body: typeof input.body === 'string' ? input.body : '',
      state: 'open',
      labels: [],
      comments: [],
      createdAt: FIXED_ISO,
      updatedAt: FIXED_ISO,
      closedAt: null,
    };
    repo.issues.set(number, issue);
    return { __typename: 'CreateIssuePayload', __issue: issueObj(repo, issue), __clientMutationId: input.clientMutationId ?? null };
  }

  closeIssue(input) {
    const found = findIssueByGlobalId(this.store, input.issueId);
    if (!found) {
      this.errors.push({ message: 'Could not resolve to an Issue with the provided id.' });
      return { __typename: 'CloseIssuePayload', __issue: null, __clientMutationId: input.clientMutationId ?? null };
    }
    found.issue.state = 'closed';
    found.issue.closedAt = FIXED_ISO;
    found.issue.updatedAt = FIXED_ISO;
    return { __typename: 'CloseIssuePayload', __issue: issueObj(found.repo, found.issue), __clientMutationId: input.clientMutationId ?? null };
  }

  createPullRequest(input) {
    const decoded = decodeGlobalId(input.repositoryId);
    const repo = decoded?.kind === 'Repository' ? findRepoByDbId(this.store, Number(decoded.rest[0])) : null;
    if (!repo) {
      this.errors.push({ message: 'Could not resolve to a Repository with the provided id.' });
      return { __typename: 'CreatePullRequestPayload', __pullRequest: null, __clientMutationId: input.clientMutationId ?? null };
    }
    const headTip = refCommit(repo, `refs/heads/${input.headRefName}`);
    const baseTip = refCommit(repo, `refs/heads/${input.baseRefName}`);
    if (!headTip || !baseTip) {
      this.errors.push({ message: 'Head or base ref not found.' });
      return { __typename: 'CreatePullRequestPayload', __pullRequest: null, __clientMutationId: input.clientMutationId ?? null };
    }
    for (const existing of repo.pulls.values()) {
      if (existing.state === 'open' && existing.head.ref === input.headRefName && existing.base.ref === input.baseRefName) {
        this.errors.push({ message: 'A pull request already exists for this head and base.' });
        return { __typename: 'CreatePullRequestPayload', __pullRequest: null, __clientMutationId: input.clientMutationId ?? null };
      }
    }
    const number = repo.nextNumber++;
    const pr = {
      number,
      restId: this.store.nextObjectId++,
      nodeId: globalId('PullRequest', `${repo.dbId}:${number}`),
      title: typeof input.title === 'string' ? input.title : '',
      body: typeof input.body === 'string' ? input.body : '',
      state: 'open',
      head: { ref: input.headRefName, sha: headTip },
      base: { ref: input.baseRefName, sha: baseTip },
      baseShaAtCreate: baseTip,
      merged: false,
      mergeCommitSha: null,
      mergedAt: null,
      closedAt: null,
      createdAt: FIXED_ISO,
      updatedAt: FIXED_ISO,
    };
    repo.pulls.set(number, pr);
    return { __typename: 'CreatePullRequestPayload', __pullRequest: prObj(repo, pr), __clientMutationId: input.clientMutationId ?? null };
  }

  mergePullRequest(input) {
    const found = findPrByGlobalId(this.store, input.pullRequestId);
    if (!found) {
      this.errors.push({ message: 'Could not resolve to a PullRequest with the provided id.' });
      return { __typename: 'MergePullRequestPayload', __pullRequest: null, __clientMutationId: input.clientMutationId ?? null };
    }
    const { repo, pr } = found;
    if (pr.merged || pr.state !== 'open') {
      this.errors.push({ message: 'Pull request is already merged or closed.' });
      return { __typename: 'MergePullRequestPayload', __pullRequest: prObj(repo, pr), __clientMutationId: input.clientMutationId ?? null };
    }
    if (prConflict(repo, pr)) {
      this.errors.push({ message: 'Merge conflict.' });
      return { __typename: 'MergePullRequestPayload', __pullRequest: prObj(repo, pr), __clientMutationId: input.clientMutationId ?? null };
    }
    const headTip = refCommit(repo, `refs/heads/${pr.head.ref}`);
    const baseTip = refCommit(repo, `refs/heads/${pr.base.ref}`);
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
    return { __typename: 'MergePullRequestPayload', __pullRequest: prObj(repo, pr), __clientMutationId: input.clientMutationId ?? null };
  }

  addComment(input) {
    const target = findIssueByGlobalId(this.store, input.subjectId) ?? null;
    let repo = null;
    let issue = null;
    if (target) { repo = target.repo; issue = target.issue; }
    else {
      const prFound = findPrByGlobalId(this.store, input.subjectId);
      if (prFound) {
        // Comments on a pull request land on its issue thread (shared number).
        repo = prFound.repo;
        issue = repo.issues.get(prFound.pr.number) ?? null;
      }
    }
    if (!repo || !issue || typeof input.body !== 'string' || input.body === '') {
      this.errors.push({ message: 'Could not resolve to a commentable subject with the provided id.' });
      return { __typename: 'AddCommentPayload', __commentEdge: null, __clientMutationId: input.clientMutationId ?? null };
    }
    const seq = repo.nextCommentId++;
    const comment = {
      restId: this.store.nextObjectId++,
      nodeId: globalId('IssueComment', `${repo.dbId}:${issue.number}:${seq}`),
      body: input.body,
      createdAt: FIXED_ISO,
      updatedAt: FIXED_ISO,
    };
    issue.comments.push(comment);
    issue.updatedAt = FIXED_ISO;
    return {
      __typename: 'AddCommentPayload',
      __commentEdge: { __typename: 'IssueCommentEdge', __node: commentObj(repo, issue, comment), __cursor: encodeCursor(issue.comments.length - 1) },
      __clientMutationId: input.clientMutationId ?? null,
    };
  }
}

// ---------------------------------------------------------------------------
// HTTP entry point (called from app.ts after auth)
// ---------------------------------------------------------------------------

export function handleGraphQL(ctx) {
  const body = ctx.jsonBody;
  if (ctx.bodyParseError) return ctx.json(400, { errors: [{ message: 'Malformed JSON body' }] });
  if (Array.isArray(body)) {
    const results = body.map((operation) => executeOperation(ctx.store, operation));
    return ctx.json(200, results);
  }
  if (body === null || typeof body !== 'object') {
    return ctx.json(400, { errors: [{ message: 'GraphQL request body must be an object' }] });
  }
  return ctx.json(200, executeOperation(ctx.store, body));
}

function executeOperation(store, operation) {
  if (typeof operation.query !== 'string') {
    return { data: null, errors: [{ message: 'Request must include a query string' }] };
  }
  let document;
  try {
    document = new Parser(tokenize(operation.query)).parseDocument();
  } catch (error) {
    return { data: null, errors: [{ message: `GraphQL syntax error: ${error.message}` }] };
  }
  const variables = operation.variables && typeof operation.variables === 'object' ? operation.variables : {};
  const executor = new Executor(store);
  return executor.run(document, variables, operation.operationName);
}
