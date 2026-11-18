// dev.ts — local development entrypoint: start the forge on a fixed port.
// The trial harness uses main.ts instead (ephemeral port + env registration).
// Run with: MAKEFUN_SHOP_TOKEN=dev-token node --experimental-strip-types dev.ts
// (PORT=3000 by default; any non-empty Bearer token is accepted locally when
// MAKEFUN_SHOP_TOKEN is unset.)

import { createApp } from './app.ts';

const port = Number(process.env.PORT ?? 3000);
const server = createApp();
server.listen(port, '127.0.0.1', () => {
  process.stdout.write(`[dev] github-core-clone listening on http://127.0.0.1:${port}\n`);
});
