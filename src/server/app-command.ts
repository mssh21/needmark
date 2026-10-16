import { createServer, connect } from 'node:net';

const portFlags = ['-p', '--port'];

/** See docs/architecture.md#local-review-proxy. / 仕様は docs/architecture.md#local-review-proxy を参照。 */
export function takePort(command: readonly string[]): { command: string[]; port?: number } {
  const rest: string[] = [];
  let port: number | undefined;
  for (let index = 0; index < command.length; index++) {
    const argument = command[index]!, inline = argument.match(/^--port=(.+)$/);
    const value = inline ? inline[1] : portFlags.includes(argument) ? command[++index] : undefined;
    if (value === undefined) { rest.push(argument); continue; }
    port = Number(value);
    if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error(`Invalid port in the development command: ${value}`);
  }
  return { command: rest, ...(port === undefined ? {} : { port }) };
}

export async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((ready, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', ready); });
  const { port } = server.address() as { port: number };
  await new Promise<void>((done) => server.close(() => done()));
  return port;
}

export async function waitForPort(port: number, stopped: () => boolean, timeout = 120_000): Promise<void> {
  for (const deadline = Date.now() + timeout; ;) {
    // A plain TCP connection is enough, and autoSelectFamily tries both IPv4 and IPv6 because dev servers differ in which one "localhost" binds.
    // TCP接続だけで十分で、autoSelectFamilyならIPv4とIPv6の両方を試せる。「localhost」でどちらに待ち受けるかは開発サーバーごとに違うため。
    const open = await new Promise<boolean>((done) => {
      const socket = connect({ port, host: 'localhost', autoSelectFamily: true });
      socket.once('connect', () => { socket.destroy(); done(true); }).once('error', () => done(false));
    });
    if (open) return;
    if (stopped()) throw new Error('The development server stopped before it started listening.');
    if (Date.now() > deadline) throw new Error(`The development server did not listen on port ${port}. If it does not read the PORT environment variable, run it with \`needmark dev --target=http://localhost:<its port>\` instead.`);
    await new Promise((wait) => setTimeout(wait, 250));
  }
}
