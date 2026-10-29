import { test } from 'node:test';

test('dependências carregam', async () => {
  await import('better-sqlite3');
  await import('yazl');
  await import('yauzl');
});
