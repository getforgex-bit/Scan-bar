// Levanta un Postgres embebido aislado para las pruebas (puerto aleatorio, sin Docker).
import EmbeddedPostgres from 'embedded-postgres';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export default async function setup() {
  const PORT = 20000 + Math.floor(Math.random() * 20000);
  const dir = path.join(os.tmpdir(), `forgex-pgtest-${process.pid}`);
  const pg = new EmbeddedPostgres({ databaseDir: dir, user: 'postgres', password: 'postgres', port: PORT, persistent: false });
  await pg.initialise();
  await pg.start();
  process.env.TEST_PG_PORT = String(PORT);
  return async () => { await pg.stop(); fs.rmSync(dir, { recursive: true, force: true }); };
}
