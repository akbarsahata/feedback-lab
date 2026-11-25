#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { generatePassword, hashPassword } from './password.mjs';

const USAGE = `Usage:
  npm run provision -- --email <email> --role researcher|member [--local] [--database feedback-lab]

Creates a Feedback Lab account directly in D1. Omitting --local runs against
the remote database and requires a Wrangler login. The generated password is
printed once and cannot be recovered later.`;

function parseArgs(argv) {
  const options = {
    email: '',
    role: 'researcher',
    local: false,
    database: 'feedback-lab',
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help' || argument === '-h') {
      options.help = true;
      continue;
    }
    if (argument === '--local') {
      options.local = true;
      continue;
    }
    if (argument === '--email' || argument === '--role' || argument === '--database') {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new Error(`${argument} requires a value.`);
      }
      index += 1;
      if (argument === '--email') options.email = value;
      if (argument === '--role') options.role = value;
      if (argument === '--database') options.database = value;
      continue;
    }
    throw new Error(`Unknown argument: ${argument}`);
  }

  return options;
}

function validate(options) {
  if (options.help) return;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(options.email)) {
    throw new Error('Provide a valid --email address.');
  }
  if (options.role !== 'researcher' && options.role !== 'member') {
    throw new Error('--role must be researcher or member.');
  }
  if (options.database.trim() === '') {
    throw new Error('--database must not be blank.');
  }
}

function sqlLiteral(value) {
  return `'${value.replaceAll("'", "''")}'`;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  validate(options);
  if (options.help) {
    console.log(USAGE);
    return;
  }

  const email = options.email.trim().toLowerCase();
  const password = generatePassword(20);
  const passwordHash = await hashPassword(password);
  const now = new Date().toISOString();
  const sql = `INSERT INTO users (id, email, password_hash, role, created_at)
VALUES (${sqlLiteral(crypto.randomUUID())}, ${sqlLiteral(email)}, ${sqlLiteral(passwordHash)}, ${sqlLiteral(options.role)}, ${sqlLiteral(now)});
`;

  const directory = mkdtempSync(join(tmpdir(), 'feedback-lab-provision-'));
  const sqlFile = join(directory, 'user.sql');
  try {
    writeFileSync(sqlFile, sql, { mode: 0o600 });
    const args = [
      'wrangler',
      'd1',
      'execute',
      options.database,
      options.local ? '--local' : '--remote',
      '--file',
      sqlFile,
      '--yes',
    ];
    execFileSync(process.platform === 'win32' ? 'npx.cmd' : 'npx', args, {
      stdio: 'inherit',
      env: process.env,
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }

  console.log('');
  console.log(`Provisioned ${email} as ${options.role}.`);
  console.log(`Password (shown once): ${password}`);
  console.log('Share it through a secure channel. There is no password reset flow.');
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    console.error('');
    console.error(USAGE);
    process.exitCode = 1;
  });
}
