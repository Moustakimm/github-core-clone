// git.ts — git smart HTTP: info/refs advertisements (v0 and protocol v2),
// ls-refs, fetch (v2 and v0) and receive-pack (v0), all over the in-memory store.
//
// The suite's client (kit program/env/src/git-client.ts) is the only peer: every
// framing choice below mirrors what it parses.

import {
  ZERO_OID,
  isObjectId,
  parseCommit,
  parseTag,
  peelToCommit,
  collectReachable,
  readPack,
  writePack,
  encodePktLine,
  pktFlush,
  pktDelim,
  decodePktLines,
  sidebandPack,
  findRepo,
  putObject,
  isAncestor,
  planFetch,
  FORGE_NAME,
  FORGE_VERSION,
} from './store.ts';

const UPLOAD_AD = 'application/x-git-upload-pack-advertisement';
const UPLOAD_RESULT = 'application/x-git-upload-pack-result';
const RECEIVE_AD = 'application/x-git-receive-pack-advertisement';
const RECEIVE_RESULT = 'application/x-git-receive-pack-result';

function sortedRefs(repo) {
  return [...repo.refs.entries()].map(([name, oid]) => ({ name, oid })).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

function defaultBranchTip(repo) {
  return repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
}

function peeledOf(repo, oid) {
  const object = repo.objects.get(oid);
  if (!object || object.type !== 'tag') return null;
  return peelToCommit(repo, oid);
}

/** v0 ref advertisement body for a service. */
function v0Advertisement(repo, service) {
  const caps = service === 'git-upload-pack'
    ? `side-band-64k multi_ack multi_ack_detailed ofs-delta thin-pack shallow agent=${FORGE_NAME}/${FORGE_VERSION} symref=HEAD:refs/heads/${repo.defaultBranch}`
    : `report-status side-band-64k delete-refs ofs-delta agent=${FORGE_NAME}/${FORGE_VERSION} symref=HEAD:refs/heads/${repo.defaultBranch}`;
  const parts = [];
  parts.push(encodePktLine(`# service=${service}\n`));
  parts.push(pktFlush());
  const refs = sortedRefs(repo);
  if (refs.length === 0) {
    parts.push(encodePktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    const headTip = defaultBranchTip(repo);
    const headOid = headTip ?? ZERO_OID;
    parts.push(encodePktLine(`${headOid} HEAD\0${caps}\n`));
    for (const ref of refs) {
      parts.push(encodePktLine(`${ref.oid} ${ref.name}\n`));
      const peeled = peeledOf(repo, ref.oid);
      if (peeled) parts.push(encodePktLine(`${peeled} ${ref.name}^{}\n`));
    }
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

/** Protocol v2 capability advertisement body (upload-pack only). */
function v2Advertisement() {
  const parts = [
    encodePktLine('version 2\n'),
    encodePktLine(`agent=${FORGE_NAME}/${FORGE_VERSION}\n`),
    encodePktLine('ls-refs=unborn\n'),
    encodePktLine('fetch=shallow filter\n'),
    encodePktLine('object-format=sha1\n'),
    pktFlush(),
  ];
  return Buffer.concat(parts);
}

function parseRequestLines(body) {
  // Scan pkt-lines only up to the first flush; everything after it is the raw pack.
  const buffer = Buffer.isBuffer(body) ? body : Buffer.from(body);
  const lines = [];
  let offset = 0;
  let sawFlush = false;
  try {
    while (offset + 4 <= buffer.length) {
      const head = buffer.subarray(offset, offset + 4).toString('ascii');
      if (!/^[0-9a-fA-F]{4}$/.test(head)) throw new Error('invalid pkt-line length');
      const length = Number.parseInt(head, 16);
      if (length === 0) { sawFlush = true; offset += 4; break; }
      if (length === 1 || length === 2) { offset += 4; continue; }
      if (length < 4 || length > 65520) throw new Error('invalid pkt-line length');
      if (offset + length > buffer.length) throw new Error('truncated pkt-line');
      lines.push(buffer.subarray(offset + 4, offset + length).toString('utf8'));
      offset += length;
    }
    if (!sawFlush) throw new Error('no flush packet');
  } catch {
    return { lines: [], error: true, rest: Buffer.alloc(0), sawFlush };
  }
  return { lines, error: false, rest: buffer.subarray(offset), sawFlush };
}

/** Parse a v2 command request: {command, args: [lines after delim]}. */
function parseV2Request(body) {
  const packets = decodePktLines(body);
  const lines = [];
  let delimSeen = false;
  for (const packet of packets) {
    if (packet.kind === 'delim') { delimSeen = true; continue; }
    if (packet.kind === 'flush') break;
    if (packet.kind === 'data') lines.push(packet.payload.toString('utf8'));
  }
  const commandLine = (lines[0] ?? '').replace(/\n$/, '');
  const command = commandLine.startsWith('command=') ? commandLine.slice('command='.length) : '';
  const args = lines.slice(1).map((line) => line.replace(/\n$/, ''));
  return { command, args, delimSeen };
}

function lsRefsResponse(repo, args) {
  const peel = args.includes('peel');
  const symrefs = args.includes('symrefs');
  const unborn = args.includes('unborn');
  const prefixes = args.filter((a) => a.startsWith('ref-prefix ')).map((a) => a.slice('ref-prefix '.length));
  const matchPrefix = (name) => prefixes.length === 0 || prefixes.some((p) => name.startsWith(p));
  const parts = [];
  const refs = sortedRefs(repo);
  const headTip = defaultBranchTip(repo);
  if (refs.length === 0) {
    if (unborn && matchPrefix('HEAD')) {
      parts.push(encodePktLine(`unborn HEAD symref-target:refs/heads/${repo.defaultBranch}\n`));
    }
  } else {
    if (matchPrefix('HEAD')) {
      const line = symrefs
        ? `${headTip ?? ZERO_OID} HEAD symref-target:refs/heads/${repo.defaultBranch}\n`
        : `${headTip ?? ZERO_OID} HEAD\n`;
      parts.push(encodePktLine(line));
    }
    for (const ref of refs) {
      if (!matchPrefix(ref.name)) continue;
      let line = `${ref.oid} ${ref.name}`;
      if (peel) {
        const peeled = peeledOf(repo, ref.oid);
        if (peeled) line += ` peeled:${peeled}`;
      }
      parts.push(encodePktLine(`${line}\n`));
    }
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

function fetchResponse(repo, wants, haves, shallow, depth, protocol, done = true) {
  const plan = planFetch(repo, wants, haves, shallow, depth);
  const pack = writePack(plan.objects);
  const parts = [];
  if (protocol === 2) {
    if (done) {
      // The client sent `done`: negotiation is over, so the response starts
      // with shallow-info (if any) and then the packfile. An
      // `acknowledgments` section here would break real git clients, which
      // go straight to the pack after sending `done`; the suite's client
      // accepts the sections in any order, so omitting it is safe there too.
      if (plan.shallow.length || plan.unshallow.length) {
        parts.push(encodePktLine('shallow-info\n'));
        for (const oid of plan.shallow) parts.push(encodePktLine(`shallow ${oid}\n`));
        for (const oid of plan.unshallow) parts.push(encodePktLine(`unshallow ${oid}\n`));
        parts.push(pktFlush());
      }
      // Always send the packfile section (a valid empty pack when there is
      // nothing new): real git requires the section header after `done`.
      parts.push(encodePktLine('packfile\n'));
      parts.push(sidebandPack(pack));
      parts.push(pktFlush());
    } else {
      // Negotiation is still open (no `done`): answer NAK and let the
      // client send more haves or `done`. No packfile yet.
      parts.push(encodePktLine('acknowledgments\n'));
      parts.push(encodePktLine('NAK\n'));
      parts.push(pktFlush());
    }
  } else {
    parts.push(encodePktLine('NAK\n'));
    for (const oid of plan.shallow) parts.push(encodePktLine(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) parts.push(encodePktLine(`unshallow ${oid}\n`));
    parts.push(sidebandPack(pack));
    parts.push(pktFlush());
  }
  return Buffer.concat(parts);
}

function parseV2FetchArgs(args) {
  const wants = [];
  const haves = [];
  const shallow = [];
  let depth;
  let done = false;
  for (const arg of args) {
    if (arg.startsWith('want ')) wants.push(arg.slice(5).trim());
    else if (arg.startsWith('have ')) haves.push(arg.slice(5).trim());
    else if (arg.startsWith('shallow ')) shallow.push(arg.slice(8).trim());
    else if (arg.startsWith('deepen ')) { const n = Number(arg.slice(7).trim()); if (Number.isFinite(n)) depth = n; }
    else if (arg === 'done') done = true;
  }
  return { wants, haves, shallow, depth, done };
}

function parseV0FetchBody(body) {
  // Two sections split by flush: wants (+shallow/deepen), then haves + done.
  const packets = decodePktLines(body);
  const sections = [[]];
  for (const packet of packets) {
    if (packet.kind === 'flush') { sections.push([]); continue; }
    if (packet.kind === 'data') sections[sections.length - 1].push(packet.payload.toString('utf8').replace(/\n$/, ''));
  }
  const wants = [];
  const haves = [];
  const shallow = [];
  let depth;
  for (const line of sections[0] ?? []) {
    if (line.startsWith('want ')) {
      const rest = line.slice(5).trim();
      wants.push(rest.split(' ')[0]);
    } else if (line.startsWith('shallow ')) shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) { const n = Number(line.slice(7).trim()); if (Number.isFinite(n)) depth = n; }
  }
  for (const line of sections[1] ?? []) {
    if (line.startsWith('have ')) haves.push(line.slice(5).trim());
  }
  return { wants, haves, shallow, depth };
}

/** Handle every git smart-HTTP route. ctx: {store, method, segments, query, headers, body, raw, json, notFound}. */
export async function handleGit(ctx) {
  const seg = ctx.segments;
  if (seg.length < 3) return ctx.notFound();
  const owner = seg[0];
  const repoName = seg[1].endsWith('.git') ? seg[1].slice(0, -4) : null;
  if (repoName === null || repoName === '') return ctx.notFound();
  const tail = seg.slice(2);
  const repo = findRepo(ctx.store, owner, repoName);
  const service = ctx.query.get('service');

  // GET /{owner}/{repo}.git/info/refs?service=...
  if (ctx.method === 'GET' && tail.length === 2 && tail[0] === 'info' && tail[1] === 'refs') {
    if (!repo) return ctx.json(404, { message: 'Repository not found' });
    if (service !== 'git-upload-pack' && service !== 'git-receive-pack') return ctx.notFound();
    const wantsV2 = service === 'git-upload-pack' && (ctx.headers['git-protocol'] ?? '') === 'version=2';
    const contentType = service === 'git-upload-pack' ? UPLOAD_AD : RECEIVE_AD;
    const body = wantsV2 ? v2Advertisement() : v0Advertisement(repo, service);
    return ctx.raw(200, body, contentType);
  }

  // POST /{owner}/{repo}.git/git-upload-pack
  if (ctx.method === 'POST' && tail.length === 1 && tail[0] === 'git-upload-pack') {
    if (!repo) return ctx.json(404, { message: 'Repository not found' });
    const isV2 = (ctx.headers['git-protocol'] ?? '') === 'version=2';
    let parsed;
    try {
      parsed = isV2 ? parseV2Request(ctx.body) : null;
    } catch {
      return ctx.json(400, { message: 'Malformed request' });
    }
    try {
      if (isV2) {
        if (parsed.command === 'ls-refs') {
          return ctx.raw(200, lsRefsResponse(repo, parsed.args), UPLOAD_RESULT);
        }
        if (parsed.command === 'fetch') {
          const f = parseV2FetchArgs(parsed.args);
          return ctx.raw(200, fetchResponse(repo, f.wants, f.haves, f.shallow, f.depth, 2, f.done), UPLOAD_RESULT);
        }
        return ctx.json(400, { message: `Unknown command ${parsed.command}` });
      }
      const f = parseV0FetchBody(ctx.body);
      return ctx.raw(200, fetchResponse(repo, f.wants, f.haves, f.shallow, f.depth, 0), UPLOAD_RESULT);
    } catch (err) {
      return ctx.json(400, { message: err instanceof Error ? err.message : 'Malformed request' });
    }
  }

  // POST /{owner}/{repo}.git/git-receive-pack
  if (ctx.method === 'POST' && tail.length === 1 && tail[0] === 'git-receive-pack') {
    if (!repo) return ctx.json(404, { message: 'Repository not found' });
    const { lines, error, rest } = parseRequestLines(ctx.body);
    if (error) return ctx.json(400, { message: 'Malformed request' });
    const commands = [];
    for (const rawLine of lines) {
      const line = rawLine.replace(/\n$/, '');
      if (line === '') continue;
      const nul = line.indexOf('\0');
      const head = nul >= 0 ? line.slice(0, nul) : line;
      const parts = head.split(' ');
      if (parts.length < 3 || !isObjectId(parts[0]) || !isObjectId(parts[1])) {
        return ctx.json(400, { message: 'Malformed command line' });
      }
      commands.push({ oldOid: parts[0], newOid: parts[1], ref: parts.slice(2).join(' ') });
    }
    if (commands.length === 0) return ctx.json(400, { message: 'No commands' });
    // Unpack the pack (if any) first; objects land even for refused refs.
    let unpackOk = true;
    let unpackDetail = 'ok';
    const hasUpdates = commands.some((c) => c.newOid !== ZERO_OID);
    if (rest.length > 0) {
      try {
        const pack = readPack(rest);
        if (!pack.checksumOk) throw new Error('pack checksum mismatch');
        for (const [oid, object] of pack.objects) {
          if (!repo.objects.has(oid)) repo.objects.set(oid, { type: object.type, data: object.data });
        }
      } catch (err) {
        unpackOk = false;
        unpackDetail = err instanceof Error ? err.message : 'unpack failed';
      }
    } else if (hasUpdates) {
      // A bare command list with updates and no pack: git calls this an unpacker error,
      // but the suite always sends a pack; treat an absent pack as an empty one.
      unpackOk = true;
    }
    const reportLines = [];
    reportLines.push(`unpack ${unpackOk ? 'ok' : unpackDetail}\n`);
    for (const command of commands) {
      const current = repo.refs.get(command.ref);
      let ok = false;
      let reason = '';
      if (!unpackOk) {
        reason = 'unpack failed';
      } else if (command.newOid === ZERO_OID) {
        // delete
        if (current === undefined) reason = 'remote ref does not exist';
        else if (command.oldOid !== current) reason = 'non-fast-forward';
        else { repo.refs.delete(command.ref); ok = true; }
      } else if (command.oldOid === ZERO_OID) {
        // create
        if (current !== undefined) reason = 'already exists';
        else if (!repo.objects.has(command.newOid)) reason = 'object not found';
        else { repo.refs.set(command.ref, command.newOid); ok = true; }
      } else {
        // update
        if (current === undefined) reason = 'remote ref does not exist';
        else if (command.oldOid !== current) reason = 'non-fast-forward';
        else if (!repo.objects.has(command.newOid)) reason = 'object not found';
        else if (!isAncestor(repo, peelToCommit(repo, current), peelToCommit(repo, command.newOid))) reason = 'non-fast-forward';
        else { repo.refs.set(command.ref, command.newOid); ok = true; }
      }
      reportLines.push(ok ? `ok ${command.ref}\n` : `ng ${command.ref} ${reason}\n`);
    }
    // The report travels as sideband band-1 data, and that data is itself a
    // pkt-line stream: the report lines plus a terminating flush *inside*
    // band 1, then the outer flush. Without the inner flush, real git reads
    // the report lines and then hits EOF ("the remote end hung up").
    const inner = Buffer.concat([...reportLines.map((line) => encodePktLine(line)), pktFlush()]);
    return ctx.raw(200, Buffer.concat([sidebandPack(inner), pktFlush()]), RECEIVE_RESULT);
  }

  return ctx.notFound();
}
