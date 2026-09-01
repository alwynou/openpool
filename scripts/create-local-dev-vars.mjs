import { randomBytes } from 'node:crypto';
import { closeSync, constants, openSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const target = fileURLToPath(
  new URL('../apps/worker/.dev.vars', import.meta.url),
);

const values = {
  ADMIN_BOOTSTRAP_TOKEN: randomBytes(32).toString('base64'),
  CREDENTIAL_MASTER_KEY: randomBytes(32).toString('base64'),
  CREDENTIAL_MASTER_KEY_ID: 'primary-v1',
  API_KEY_PEPPER: randomBytes(32).toString('base64'),
};

const contents = `${Object.entries(values)
  .map(([name, value]) => `${name}=${value}`)
  .join('\n')}\n`;

let descriptor;
try {
  descriptor = openSync(
    target,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
    0o600,
  );
  writeFileSync(descriptor, contents, { encoding: 'utf8' });
} catch (error) {
  if (error && typeof error === 'object' && error.code === 'EEXIST') {
    console.error('apps/worker/.dev.vars already exists; refusing to overwrite it.');
    process.exitCode = 1;
  } else {
    throw error;
  }
} finally {
  if (descriptor !== undefined) closeSync(descriptor);
}

if (process.exitCode === undefined) {
  console.log('Created apps/worker/.dev.vars with mode 0600. Secret values were not printed.');
}
