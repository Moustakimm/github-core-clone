// store.ts — the forge's in-memory store: git object model, pack codec, pkt-lines,
// repositories, issues, pull requests, and the git graph algorithms (reachability,
// fetch planning, tree diff, merge-base, conflict detection).
//
// Pure Node standard library (node:crypto, node:zlib). Written in plain JavaScript
// syntax inside a .ts file so Node's type stripping runs it unchanged.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export const ZERO_OID = '0'.repeat(40);

// The token owner, fixed by the suite's seeded scenario (wire.ts buildScenario()).
export const VIEWER = Object.freeze({
  id: 1000,
  login: 'adaiversen',
  name: 'ada iversen',
  email: 'adaiversen@example.invalid',
});

// Fixed timestamps: nothing the server stores may read the wall clock, so a live
// run and its replay leave identical state.
export const FIXED_EPOCH = 1735689600; // 2025-01-01T00:00:00Z
export const FIXED_ISO = '2025-01-01T00:00:00.000Z';
export const FORGE_NAME = 'github-core-clone';
export const FORGE_VERSION = '1.0.0';

// ---------------------------------------------------------------------------
// git object model
// ---------------------------------------------------------------------------

const TYPE_CODE = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };
const HEX40 = /^[0-9a-f]{40}$/;

export function isObjectId(value) {
  return typeof value === 'string' && HEX40.test(value);
}

export function hashObject(type, data) {
  const body = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const hash = createHash('sha1');
  hash.update(Buffer.from(`${type} ${body.length}\0`, 'utf8'));
  hash.update(body);
  return hash.digest('hex');
}

export function parseTree(data) {
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const entries = [];
  let offset = 0;
  while (offset < buffer.length) {
    const space = buffer.indexOf(0x20, offset);
    if (space < 0) throw new Error('tree entry has no mode separator');
    const nul = buffer.indexOf(0x00, space + 1);
    if (nul < 0) throw new Error('tree entry has no name terminator');
    if (nul + 21 > buffer.length) throw new Error('tree entry has a truncated object id');
    const mode = buffer.subarray(offset, space).toString('ascii');
    const name = buffer.subarray(space + 1, nul).toString('utf8');
    const oid = buffer.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

function compareTreeNames(a, b) {
  const left = Buffer.from(a.mode === '40000' ? `${a.name}/` : a.name, 'utf8');
  const right = Buffer.from(b.mode === '40000' ? `${b.name}/` : b.name, 'utf8');
  return Buffer.compare(left, right);
}

export function buildTree(entries) {
  const sorted = [...entries].sort(compareTreeNames);
  const parts = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export function parseCommit(data) {
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const blank = buffer.indexOf('\n\n');
  const headerEnd = blank < 0 ? buffer.length : blank;
  const headerText = buffer.subarray(0, headerEnd).toString('utf8');
  const message = blank < 0 ? '' : buffer.subarray(blank + 2).toString('utf8');
  let tree = '';
  const parents = [];
  let author = '';
  let committer = '';
  const extra = [];
  for (const line of headerText.split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    const key = space < 0 ? line : line.slice(0, space);
    const value = space < 0 ? '' : line.slice(space + 1);
    if (key === 'tree') tree = value;
    else if (key === 'parent') parents.push(value);
    else if (key === 'author') author = value;
    else if (key === 'committer') committer = value;
    else extra.push([key, value]);
  }
  return { tree, parents, author, committer, message, extraHeaders: extra };
}

export function buildCommit(fields) {
  const timestamp = fields.timestamp ?? FIXED_EPOCH;
  const timezone = fields.timezone ?? '+0000';
  const author = fields.author ?? `${VIEWER.name} <${VIEWER.email}>`;
  const committer = fields.committer ?? author;
  const lines = [`tree ${fields.tree}`];
  for (const parent of fields.parents ?? []) lines.push(`parent ${parent}`);
  lines.push(`author ${author} ${timestamp} ${timezone}`, `committer ${committer} ${timestamp} ${timezone}`, '');
  return Buffer.from(`${lines.join('\n')}\n${fields.message}`, 'utf8');
}

export function parseTag(data) {
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const blank = buffer.indexOf('\n\n');
  const headerEnd = blank < 0 ? buffer.length : blank;
  const headers = new Map();
  for (const line of buffer.subarray(0, headerEnd).toString('utf8').split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    if (space < 0) continue;
    headers.set(line.slice(0, space), line.slice(space + 1));
  }
  return {
    object: headers.get('object') ?? '',
    type: headers.get('type') ?? '',
    tag: headers.get('tag') ?? '',
    tagger: headers.get('tagger') ?? '',
    message: blank < 0 ? '' : buffer.subarray(blank + 2).toString('utf8'),
  };
}

export function buildTag(fields) {
  const timestamp = fields.timestamp ?? FIXED_EPOCH;
  const timezone = fields.timezone ?? '+0000';
  const tagger = `${fields.tagger ?? `${VIEWER.name} <${VIEWER.email}>`} ${timestamp} ${timezone}`;
  return Buffer.from(
    `object ${fields.object}\ntype ${fields.type}\ntag ${fields.tag}\ntagger ${tagger}\n\n${fields.message}`,
    'utf8',
  );
}

/** Every object reachable from roots (commit -> tree + parents, tag -> target, tree -> entries). */
export function collectReachable(roots, lookup, options = {}) {
  const seen = new Set();
  const queue = [];
  for (const root of roots) if (isObjectId(root)) queue.push(root);
  while (queue.length) {
    const oid = queue.pop();
    if (seen.has(oid)) continue;
    const object = lookup(oid);
    if (!object) {
      if (options.allowMissing) continue;
      throw new Error(`object ${oid} is missing from the store`);
    }
    seen.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      queue.push(commit.tree);
      for (const parent of commit.parents) queue.push(parent);
    } else if (object.type === 'tag') {
      queue.push(parseTag(object.data).object);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) {
        if (entry.mode === '160000') continue;
        queue.push(entry.oid);
      }
    }
  }
  return seen;
}

// ---------------------------------------------------------------------------
// packfile codec (read: plain + ofs/ref deltas; write: plain objects)
// ---------------------------------------------------------------------------

function readVarintSize(buffer, start) {
  let byte = buffer[start];
  const first = byte;
  let size = byte & 0x0f;
  let shift = 4;
  let offset = start + 1;
  while (byte & 0x80) {
    byte = buffer[offset++];
    size += (byte & 0x7f) * 2 ** shift;
    shift += 7;
  }
  return { size, next: offset, first };
}

function readOfsDeltaBase(buffer, start) {
  let byte = buffer[start];
  let offset = start + 1;
  let value = byte & 0x7f;
  while (byte & 0x80) {
    byte = buffer[offset++];
    value = ((value + 1) * 128) + (byte & 0x7f);
  }
  return { baseOffset: value, next: offset };
}

function inflateAt(buffer, offset) {
  const view = buffer.subarray(offset);
  const result = inflateSync(view, { info: true });
  const written = result.engine.bytesWritten;
  if (!written || written <= 0) throw new Error(`zlib stream at offset ${offset} consumed no bytes`);
  return { data: result.buffer, next: offset + written };
}

export function applyDelta(base, delta) {
  const baseBuffer = Buffer.isBuffer(base) ? base : Buffer.from(base);
  const deltaBuffer = Buffer.isBuffer(delta) ? delta : Buffer.from(delta);
  let offset = 0;
  const readSize = () => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = deltaBuffer[offset++];
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(byte & 0x80)) break;
    }
    return value;
  };
  const sourceSize = readSize();
  const targetSize = readSize();
  if (sourceSize !== baseBuffer.length) throw new Error('delta expects a different base size');
  const out = Buffer.allocUnsafe(targetSize);
  let written = 0;
  while (offset < deltaBuffer.length) {
    const op = deltaBuffer[offset++];
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) copyOffset += deltaBuffer[offset++] * 2 ** shift;
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) {
        if (op & (1 << bit)) copySize += deltaBuffer[offset++] * 2 ** shift;
        shift += 8;
      }
      if (copySize === 0) copySize = 0x10000;
      baseBuffer.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      const literal = op & 0x7f;
      deltaBuffer.copy(out, written, offset, offset + literal);
      offset += literal;
      written += literal;
    } else {
      throw new Error('delta opcode 0 is invalid');
    }
  }
  if (written !== targetSize) throw new Error('delta produced the wrong size');
  return out;
}

export function readPack(pack) {
  const buffer = Buffer.isBuffer(pack) ? pack : Buffer.from(pack);
  if (buffer.length < 32) throw new Error('pack is too short');
  if (buffer.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('pack does not start with PACK');
  const version = buffer.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const declaredCount = buffer.readUInt32BE(8);
  const trailerStart = buffer.length - 20;
  const trailer = buffer.subarray(trailerStart).toString('hex');
  const computedTrailer = createHash('sha1').update(buffer.subarray(0, trailerStart)).digest('hex');
  const raw = [];
  const byOffset = new Map();
  let offset = 12;
  for (let index = 0; index < declaredCount; index += 1) {
    const entryOffset = offset;
    const header = readVarintSize(buffer, offset);
    offset = header.next;
    const typeCode = (header.first >> 4) & 0x07;
    const entry = { offset: entryOffset, typeCode, size: header.size, data: Buffer.alloc(0) };
    if (typeCode === 6) {
      const base = readOfsDeltaBase(buffer, offset);
      offset = base.next;
      entry.baseOffset = entryOffset - base.baseOffset;
    } else if (typeCode === 7) {
      entry.baseOid = buffer.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    } else if (!CODE_TYPE[typeCode]) {
      throw new Error(`pack entry ${index} has unknown type code ${typeCode}`);
    }
    const inflated = inflateAt(buffer.subarray(0, trailerStart), offset);
    if (inflated.data.length !== header.size) throw new Error('pack entry size mismatch');
    entry.data = inflated.data;
    offset = inflated.next;
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }
  if (offset !== trailerStart) throw new Error('pack has stray bytes before its trailer');
  const objects = new Map();
  const resolvedByOid = new Map();
  const resolving = new Set();
  let deltaCount = 0;
  const resolve = (entry) => {
    if (entry.resolved) return { type: entry.resolvedType, data: entry.resolved, oid: entry.oid };
    if (resolving.has(entry.offset)) throw new Error('delta cycle in pack');
    resolving.add(entry.offset);
    let type;
    let data;
    if (entry.typeCode === 6) {
      const base = resolve(byOffset.get(entry.baseOffset));
      type = base.type;
      data = applyDelta(base.data, entry.data);
    } else if (entry.typeCode === 7) {
      const baseEntry = resolvedByOid.get(entry.baseOid);
      if (!baseEntry) throw new Error(`ref-delta base ${entry.baseOid} is not in the pack`);
      const base = resolve(baseEntry);
      type = base.type;
      data = applyDelta(base.data, entry.data);
    } else {
      type = CODE_TYPE[entry.typeCode];
      data = entry.data;
    }
    const oid = hashObject(type, data);
    entry.resolved = data;
    entry.resolvedType = type;
    entry.oid = oid;
    resolvedByOid.set(oid, entry);
    resolving.delete(entry.offset);
    return { type, data, oid };
  };
  for (const entry of raw) {
    const resolved = resolve(entry);
    if (entry.typeCode === 6 || entry.typeCode === 7) deltaCount += 1;
    if (!objects.has(resolved.oid)) objects.set(resolved.oid, { type: resolved.type, data: resolved.data });
  }
  return { version, declaredCount, objects, trailer, computedTrailer, checksumOk: trailer === computedTrailer, deltaCount, byteLength: buffer.length };
}

function writePackObjectHeader(type, size) {
  const code = TYPE_CODE[type];
  const bytes = [];
  let remaining = size;
  let first = (code << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

export function writePack(objects) {
  const list = [...objects];
  const parts = [];
  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(list.length, 8);
  parts.push(header);
  for (const object of list) {
    const data = Buffer.isBuffer(object.data) ? object.data : Buffer.from(object.data);
    parts.push(writePackObjectHeader(object.type, data.length));
    parts.push(deflateSync(data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

// ---------------------------------------------------------------------------
// pkt-lines
// ---------------------------------------------------------------------------

export const PKT_LINE_MAX = 65520;

export function encodePktLine(payload) {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  if (data.length > PKT_LINE_MAX - 4) throw new Error('pkt-line payload too long');
  const header = Buffer.allocUnsafe(4);
  header.write((data.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([header, data]);
}

export function pktFlush() {
  return Buffer.from('0000', 'ascii');
}

export function pktDelim() {
  return Buffer.from('0001', 'ascii');
}

/** Decode a whole buffer into packets (data payloads and control markers). */
export function decodePktLines(bytes) {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  const packets = [];
  let offset = 0;
  const hex4 = /^[0-9a-fA-F]{4}$/;
  while (offset < buffer.length) {
    if (offset + 4 > buffer.length) throw new Error('truncated pkt-line');
    const head = buffer.subarray(offset, offset + 4).toString('ascii');
    if (!hex4.test(head)) throw new Error(`invalid pkt-line length ${JSON.stringify(head)}`);
    const length = Number.parseInt(head, 16);
    if (length === 0) { packets.push({ kind: 'flush' }); offset += 4; continue; }
    if (length === 1) { packets.push({ kind: 'delim' }); offset += 4; continue; }
    if (length === 2) { packets.push({ kind: 'response-end' }); offset += 4; continue; }
    if (length < 4 || length > PKT_LINE_MAX) throw new Error('invalid pkt-line length');
    if (offset + length > buffer.length) throw new Error('truncated pkt-line');
    packets.push({ kind: 'data', payload: buffer.subarray(offset + 4, offset + length), raw: buffer.subarray(offset, offset + length) });
    offset += length;
  }
  return packets;
}

/** Split sideband-64k framed data: returns {pack: Buffer, progress: string}. */
export function demuxSideband(chunks) {
  const packChunks = [];
  let progress = '';
  for (const chunk of chunks) {
    if (chunk.length < 1) continue;
    const band = chunk[0];
    if (band === 1) packChunks.push(chunk.subarray(1));
    else if (band === 2) progress += chunk.subarray(1).toString('utf8');
    else if (band === 3) throw new Error(`sideband error: ${chunk.subarray(1).toString('utf8').trim()}`);
  }
  return { pack: Buffer.concat(packChunks), progress };
}

/** Frame a pack into sideband-64k pkt-lines (band 1), each <= 65520 bytes. */
export function sidebandPack(pack) {
  const parts = [];
  const maxChunk = PKT_LINE_MAX - 4 - 1;
  for (let offset = 0; offset < pack.length; offset += maxChunk) {
    const slice = pack.subarray(offset, Math.min(pack.length, offset + maxChunk));
    parts.push(encodePktLine(Buffer.concat([Buffer.from([1]), slice])));
  }
  if (pack.length === 0) parts.push(encodePktLine(Buffer.from([1])));
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// the store
// ---------------------------------------------------------------------------

export function createStore() {
  return {
    repos: new Map(),
    nextDbId: 1,
    nextObjectId: 1, // global REST `id` counter (repos, issues, PRs, comments)
    requestSeq: 0,
  };
}

export function globalId(kind, id) {
  return Buffer.from(`${kind}:${id}`).toString('base64');
}

export function decodeGlobalId(gid) {
  try {
    const text = Buffer.from(String(gid), 'base64').toString('utf8');
    const parts = text.split(':');
    return { kind: parts[0], rest: parts.slice(1) };
  } catch {
    return null;
  }
}

export function createRepoRecord(store, name, opts = {}) {
  const dbId = store.nextDbId++;
  const restId = store.nextObjectId++;
  const repo = {
    name,
    owner: VIEWER.login,
    description: opts.description ?? '',
    private: opts.private ?? false,
    defaultBranch: 'main',
    dbId,
    restId,
    nodeId: globalId('Repository', dbId),
    refs: new Map(), // refname -> oid
    objects: new Map(), // oid -> {type, data}
    issues: new Map(), // number -> issue
    pulls: new Map(), // number -> pr
    labels: new Map(), // name -> {name, color}
    nextNumber: 1, // shared issue + PR numbers, GitHub style
    nextCommentId: 1,
    seq: dbId,
  };
  store.repos.set(name, repo);
  return repo;
}

export function findRepo(store, owner, name) {
  if (owner !== VIEWER.login) return null;
  return store.repos.get(name) ?? null;
}

export function repoObject(repo, oid) {
  return repo.objects.get(oid);
}

export function putObject(repo, type, data) {
  const body = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const oid = hashObject(type, body);
  if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data: body });
  return oid;
}

/** Peel a tag (recursively) to its commit, or return the oid unchanged. */
export function peelToCommit(repo, oid) {
  let current = oid;
  for (let i = 0; i < 10; i += 1) {
    const object = repo.objects.get(current);
    if (!object || object.type !== 'tag') return current;
    current = parseTag(object.data).object;
  }
  return current;
}

/** The commit a ref points at (peeling tags), or null. */
export function refCommit(repo, refName) {
  const oid = repo.refs.get(refName);
  if (!oid) return null;
  return peelToCommit(repo, oid);
}

/** Flatten a tree to path -> {oid, mode}, recursively. */
export function flattenTree(repo, treeOid, prefix = '', out = new Map()) {
  const object = repo.objects.get(treeOid);
  if (!object || object.type !== 'tree') return out;
  for (const entry of parseTree(object.data)) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.mode === '40000') flattenTree(repo, entry.oid, path, out);
    else out.set(path, { oid: entry.oid, mode: entry.mode });
  }
  return out;
}

/** Build (and store) a tree from a flat path map; returns the tree oid. */
export function treeFromFlat(repo, flat) {
  const build = (paths) => {
    const files = [];
    const dirs = new Map();
    for (const [path, value] of paths) {
      const slash = path.indexOf('/');
      if (slash < 0) files.push({ mode: value.mode, name: path, oid: value.oid });
      else {
        const dir = path.slice(0, slash);
        if (!dirs.has(dir)) dirs.set(dir, []);
        dirs.get(dir).push([path.slice(slash + 1), value]);
      }
    }
    const entries = [...files];
    for (const [dir, sub] of dirs) entries.push({ mode: '40000', name: dir, oid: build(sub) });
    return putObject(repo, 'tree', buildTree(entries));
  };
  return build([...flat.entries()]);
}

/**
 * Commit a set of file writes/deletes on a branch. `changes` maps path -> Buffer (or null
 * to delete). Creates blob/tree/commit objects and moves the ref. Returns the commit oid.
 */
export function commitFiles(repo, branch, changes, message) {
  const refName = `refs/heads/${branch}`;
  const currentTip = refCommit(repo, refName);
  let flat = new Map();
  if (currentTip) {
    const commit = parseCommit(repo.objects.get(currentTip).data);
    flat = flattenTree(repo, commit.tree);
  }
  for (const [path, content] of changes) {
    if (content === null || content === undefined) flat.delete(path);
    else flat.set(path, { oid: putObject(repo, 'blob', content), mode: '100644' });
  }
  const treeOid = treeFromFlat(repo, flat);
  const commitData = buildCommit({
    tree: treeOid,
    parents: currentTip ? [currentTip] : [],
    message: message.endsWith('\n') ? message : `${message}\n`,
    timestamp: FIXED_EPOCH,
  });
  const commitOid = putObject(repo, 'commit', commitData);
  repo.refs.set(refName, commitOid);
  return commitOid;
}

/** List commits reachable from `tip` (or a ref name), newest first. */
export function listCommits(repo, from, limit = 100) {
  let tip = from;
  if (typeof from === 'string' && !isObjectId(from)) {
    tip = refCommit(repo, `refs/heads/${from}`) ?? refCommit(repo, from);
  }
  if (!tip) return [];
  const out = [];
  const seen = new Set();
  const queue = [tip];
  while (queue.length && out.length < limit) {
    const oid = queue.shift();
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'commit') continue;
    out.push(oid);
    const commit = parseCommit(object.data);
    for (const parent of commit.parents) queue.push(parent);
  }
  return out;
}

/** The ancestor set of a commit (including itself). */
export function ancestorSet(repo, tip) {
  const set = new Set();
  const queue = [tip];
  while (queue.length) {
    const oid = queue.pop();
    if (!oid || set.has(oid)) continue;
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'commit') continue;
    set.add(oid);
    for (const parent of parseCommit(object.data).parents) queue.push(parent);
  }
  return set;
}

/** The merge-base of two commits: the first ancestor of `a` that is also an ancestor of `b`. */
export function mergeBase(repo, a, b) {
  if (!a || !b) return null;
  const bAncestors = ancestorSet(repo, b);
  const queue = [a];
  const seen = new Set();
  while (queue.length) {
    const oid = queue.shift();
    if (!oid || seen.has(oid)) continue;
    seen.add(oid);
    if (bAncestors.has(oid)) return oid;
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) queue.push(parent);
  }
  return null;
}

/** True when `ancestor` is reachable from `descendant` (or they are equal). */
export function isAncestor(repo, ancestor, descendant) {
  if (ancestor === descendant) return true;
  if (!ancestor || !descendant) return false;
  return ancestorSet(repo, descendant).has(ancestor);
}

/** Diff two trees: [{path, status, oldOid, newOid, additions, deletions}]. */
export function diffTrees(repo, baseTreeOid, headTreeOid) {
  const base = baseTreeOid ? flattenTree(repo, baseTreeOid) : new Map();
  const head = headTreeOid ? flattenTree(repo, headTreeOid) : new Map();
  const paths = new Set([...base.keys(), ...head.keys()]);
  const out = [];
  for (const path of [...paths].sort()) {
    const b = base.get(path);
    const h = head.get(path);
    if (b && h && b.oid === h.oid) continue;
    let status;
    if (!b) status = 'added';
    else if (!h) status = 'removed';
    else status = 'modified';
    let additions = 0;
    let deletions = 0;
    const oldText = b ? blobText(repo, b.oid) : '';
    const newText = h ? blobText(repo, h.oid) : '';
    if (status === 'added') additions = countLines(newText);
    else if (status === 'removed') deletions = countLines(oldText);
    else {
      const counts = lineDiffCounts(oldText, newText);
      additions = counts.additions;
      deletions = counts.deletions;
    }
    out.push({ path, status, oldOid: b?.oid ?? null, newOid: h?.oid ?? null, additions, deletions, changes: additions + deletions });
  }
  return out;
}

export function blobText(repo, oid) {
  const object = repo.objects.get(oid);
  if (!object || object.type !== 'blob') return '';
  return object.data.toString('utf8');
}

function countLines(text) {
  if (text === '') return 0;
  return text.split('\n').filter((line, i, arr) => !(i === arr.length - 1 && line === '')).length;
}

/** Cheap line diff: trim common prefix/suffix lines, count what is left. */
function lineDiffCounts(oldText, newText) {
  const a = oldText === '' ? [] : oldText.split('\n');
  const b = newText === '' ? [] : newText.split('\n');
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA -= 1; endB -= 1; }
  return { additions: Math.max(0, endB - start), deletions: Math.max(0, endA - start) };
}

/**
 * Plan a fetch: which objects to send for `wants` given the client's `haves`,
 * existing shallow boundaries and an optional `depth`.
 * Returns {objects: [{type, data, oid}], shallow: [oid], unshallow: [oid]}.
 */
export function planFetch(repo, wants, haves, shallow, depth) {
  const haveCommits = new Set();
  for (const h of haves ?? []) {
    const object = repo.objects.get(h);
    if (!object) continue;
    if (object.type === 'commit') haveCommits.add(h);
    else if (object.type === 'tag') {
      const target = peelToCommit(repo, h);
      if (repo.objects.get(target)?.type === 'commit') haveCommits.add(target);
    }
  }
  const shallowSet = new Set(shallow ?? []);
  const included = new Set();
  const includedTags = new Set();
  const boundary = new Set();
  const deepened = new Set();
  const visited = new Set();
  const queue = [];
  for (const want of wants) {
    const object = repo.objects.get(want);
    if (!object) continue;
    if (object.type === 'tag') {
      includedTags.add(want);
      const target = peelToCommit(repo, want);
      if (repo.objects.get(target)?.type === 'commit') queue.push({ oid: target, d: 1 });
    } else if (object.type === 'commit') {
      queue.push({ oid: want, d: 1 });
    }
  }
  while (queue.length) {
    const { oid, d } = queue.shift();
    if (visited.has(oid)) continue;
    visited.add(oid);
    if (haveCommits.has(oid)) {
      // Already held: stop, unless this is an old shallow boundary being deepened.
      if (depth != null && shallowSet.has(oid) && d < depth) {
        deepened.add(oid);
        const object = repo.objects.get(oid);
        if (object?.type === 'commit') {
          for (const parent of parseCommit(object.data).parents) queue.push({ oid: parent, d: d + 1 });
        }
      }
      continue;
    }
    included.add(oid);
    if (depth != null && d >= depth) {
      boundary.add(oid);
      continue;
    }
    const object = repo.objects.get(oid);
    if (object?.type === 'commit') {
      for (const parent of parseCommit(object.data).parents) queue.push({ oid: parent, d: d + 1 });
    }
  }
  // Expand each included commit to the objects it needs, without crossing the
  // depth boundary: trees and blobs are followed fully, but a parent commit
  // is followed only when it is itself included (within the requested
  // depth). Expanding with collectReachable here would re-attach the whole
  // history and defeat depth-1 shallow clones.
  const sendSet = new Set();
  const stack = [...included, ...includedTags];
  const expanded = new Set();
  while (stack.length) {
    const oid = stack.pop();
    if (expanded.has(oid)) continue;
    expanded.add(oid);
    const object = repo.objects.get(oid);
    if (!object) continue;
    sendSet.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      if (commit.tree) stack.push(commit.tree);
      for (const parent of commit.parents) {
        if (included.has(parent)) stack.push(parent);
      }
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) stack.push(entry.oid);
    } else if (object.type === 'tag') {
      const tag = parseTag(object.data);
      if (tag.object) stack.push(tag.object);
    }
  }
  const haveReachable = heldReachable(repo, haves, shallowSet);
  const objects = [];
  for (const oid of [...sendSet].sort()) {
    if (haveReachable.has(oid)) continue;
    const object = repo.objects.get(oid);
    if (object) objects.push({ type: object.type, data: object.data, oid });
  }
  return {
    objects,
    shallow: [...boundary].sort(),
    unshallow: [...deepened].sort(),
  };
}

/**
 * Objects the client already holds: the closure of its haves, stopping at
 * the shallow boundaries it declared — a boundary commit's parents are not
 * held (the client stopped there), so they must still be delivered when a
 * deepen asks for them. A plain collectReachable over the haves would
 * wrongly treat those parents as held and filter them out of the pack.
 */
function heldReachable(repo, haves, shallowSet) {
  const seen = new Set();
  const queue = [...(haves ?? [])];
  while (queue.length) {
    const oid = queue.pop();
    if (!oid || seen.has(oid)) continue;
    const object = repo.objects.get(oid);
    if (!object) continue;
    seen.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      if (commit.tree) queue.push(commit.tree);
      if (!shallowSet.has(oid)) {
        for (const parent of commit.parents) queue.push(parent);
      }
    } else if (object.type === 'tag') {
      const target = parseTag(object.data).object;
      if (target) queue.push(target);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) queue.push(entry.oid);
    }
  }
  return seen;
}

/** Is a pull request's head mergeable into its base without conflicts? */
export function prConflict(repo, pr) {
  const headTip = refCommit(repo, `refs/heads/${pr.head.ref}`);
  const baseTip = refCommit(repo, `refs/heads/${pr.base.ref}`);
  if (!headTip || !baseTip) return true;
  const base = mergeBase(repo, headTip, baseTip);
  if (!base) return false;
  const baseCommit = parseCommit(repo.objects.get(base).data);
  const headCommit = parseCommit(repo.objects.get(headTip).data);
  const baseTipCommit = parseCommit(repo.objects.get(baseTip).data);
  const headChanges = diffTrees(repo, baseCommit.tree, headCommit.tree);
  const baseChanges = new Map(diffTrees(repo, baseCommit.tree, baseTipCommit.tree).map((d) => [d.path, d]));
  for (const change of headChanges) {
    const other = baseChanges.get(change.path);
    if (!other) continue;
    if (other.newOid !== change.newOid) return true;
  }
  return false;
}
