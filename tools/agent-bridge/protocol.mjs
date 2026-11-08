export const PEERS = ['windows', 'mac'];
export const MAX_PENDING = 100;
export const MAX_BODY = 256 * 1024;

export function handoff(payload, event, env) {
  if (event !== 'issue_comment' || payload.action !== 'created') return null;
  if (payload.repository?.full_name !== env.REPO) return null;
  const issues = String(env.ALLOWED_ISSUES).split(',').map(Number);
  const actors = String(env.ALLOWED_ACTORS).toLowerCase().split(',').map(s => s.trim());
  if (!issues.includes(payload.issue?.number)) return null;
  if (!actors.includes(payload.sender?.login?.toLowerCase()) || !actors.includes(payload.comment?.user?.login?.toLowerCase())) return null;
  const match = /^\[BRIDGE TO (WINDOWS|MAC)\](?:\r?\n|$)/.exec(payload.comment?.body ?? '');
  if (!match || !Number.isSafeInteger(payload.comment?.id) || payload.comment.id <= 0) return null;
  const created = Date.parse(payload.comment.created_at);
  if (!Number.isFinite(created) || created > Date.now() + 60_000 || created < Date.now() - 7 * 86_400_000) return null;
  const to = match[1].toLowerCase();
  return {
    type: 'handoff', id: `github-${payload.comment.id}`, to,
    repo: env.REPO, issue: payload.issue.number, commentId: payload.comment.id,
    url: `https://github.com/${env.REPO}/issues/${payload.issue.number}#issuecomment-${payload.comment.id}`,
    actor: payload.comment.user.login, createdAt: payload.comment.created_at,
  };
}

export async function validSignature(body, signature, secret) {
  if (!secret || !/^sha256=[a-f0-9]{64}$/.test(signature ?? '')) return false;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  const bytes = Uint8Array.from(signature.slice(7).match(/../g), s => parseInt(s, 16));
  return crypto.subtle.verify('HMAC', key, bytes, new TextEncoder().encode(body));
}

export async function hash(value) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))].map(b => b.toString(16).padStart(2, '0')).join('');
}

export function validatePacket(packet, peer, config) {
  return packet?.type === 'handoff' && packet.to === peer && packet.repo === config.repo &&
    config.issues.includes(packet.issue) && Number.isSafeInteger(packet.commentId) && packet.commentId > 0 &&
    packet.id === `github-${packet.commentId}` &&
    config.actors.map(a => a.toLowerCase()).includes(packet.actor?.toLowerCase()) &&
    packet.url === `https://github.com/${config.repo}/issues/${packet.issue}#issuecomment-${packet.commentId}`;
}
