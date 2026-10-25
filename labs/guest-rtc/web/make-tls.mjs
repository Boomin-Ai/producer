import { spawnSync } from 'node:child_process';
import { mkdir, writeFile, chmod } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const runtime = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../runtime');
await mkdir(runtime, { recursive: true });
await writeFile(path.join(runtime, 'tls-leaf.ext'), 'basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:localhost,IP:127.0.0.1\n');
for (const args of [
  ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'tls-ca-key.pem', '-out', 'tls-ca.pem', '-subj', '/CN=Producer Guest Lab CA', '-days', '2', '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign,cRLSign'],
  ['req', '-new', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'tls-key.pem', '-out', 'tls-leaf.csr', '-subj', '/CN=localhost'],
  ['x509', '-req', '-in', 'tls-leaf.csr', '-CA', 'tls-ca.pem', '-CAkey', 'tls-ca-key.pem', '-CAcreateserial', '-out', 'tls-cert.pem', '-days', '2', '-extfile', 'tls-leaf.ext'],
]) {
  const result = spawnSync('openssl', args, { cwd: runtime, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr);
}
await chmod(path.join(runtime, 'tls-key.pem'), 0o600);
await chmod(path.join(runtime, 'tls-ca-key.pem'), 0o600);
console.log('Generated loopback CA and server certificate; no keychain changes.');
