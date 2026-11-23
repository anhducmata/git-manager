import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'index.js');

let home;
let env;

function run(cmd, args, cwd) {
  return execFileSync(cmd, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
}
const gitm = (args, cwd) => run(process.execPath, [cli, ...args], cwd);
const email = cwd => run('git', ['config', 'user.email'], cwd);
const sshCommand = cwd => run('git', ['config', 'core.sshCommand'], cwd);

function makeRepo(...parts) {
  const dir = path.join(home, ...parts);
  fs.mkdirSync(dir, { recursive: true });
  run('git', ['init', '-q'], dir);
  return dir;
}

before(() => {
  // A throwaway HOME so the real ~/.gitconfig and ~/.config are never touched
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'gitm-test-'));
  env = { ...process.env, HOME: home, USERPROFILE: home, GIT_CONFIG_NOSYSTEM: '1' };
  delete env.GIT_CONFIG_GLOBAL;
  delete env.XDG_CONFIG_HOME;

  const configDir = path.join(home, '.config', 'git-manager');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, 'accounts.json'), JSON.stringify([
    { profileName: 'Work', name: 'Work Me', email: 'me@work.test', sshKeyPath: '/keys/work' },
    { profileName: 'Personal', name: 'Home Me', email: 'me@home.test', sshKeyPath: '/keys/personal' },
    { profileName: 'Client', name: 'Client Me', email: 'me@client.test', sshKeyPath: '/keys/client' }
  ]));

  run('git', ['config', '--global', 'user.name', 'Work Me'], home);
  run('git', ['config', '--global', 'user.email', 'me@work.test'], home);
  run('git', ['config', '--global', 'core.sshCommand', 'ssh -i /keys/work -o IdentitiesOnly=yes'], home);
});

after(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

test('folder rule applies to the folder and all sub-folders only', () => {
  const inside = makeRepo('personal', 'repo');
  const deep = makeRepo('personal', 'a', 'b', 'deep repo');
  const outside = makeRepo('elsewhere', 'repo');
  const sibling = makeRepo('personal-other', 'repo');

  gitm(['folder', 'personal'], path.join(home, 'personal'));

  assert.equal(email(inside), 'me@home.test');
  assert.equal(email(deep), 'me@home.test');
  assert.equal(sshCommand(deep), 'ssh -i /keys/personal -o IdentitiesOnly=yes');
  assert.equal(run('git', ['config', 'user.name'], deep), 'Home Me');

  assert.equal(email(outside), 'me@work.test');
  assert.equal(sshCommand(outside), 'ssh -i /keys/work -o IdentitiesOnly=yes');
  assert.equal(email(sibling), 'me@work.test', 'a folder sharing the name prefix must not match');
});

test('the deepest folder rule wins', () => {
  const nested = makeRepo('personal', 'client', 'repo');
  gitm(['folder', 'Client'], path.join(home, 'personal', 'client'));

  assert.equal(email(nested), 'me@client.test');
  assert.equal(email(path.join(home, 'personal', 'repo')), 'me@home.test');

  // Re-setting the parent must not push it above the child
  gitm(['folder', 'Personal'], path.join(home, 'personal'));
  assert.equal(email(nested), 'me@client.test');
});

test('setting the same folder twice replaces the rule', () => {
  const dir = path.join(home, 'personal', 'client');
  gitm(['folder', 'Work'], dir);
  assert.equal(email(path.join(dir, 'repo')), 'me@work.test');

  const rules = JSON.parse(fs.readFileSync(path.join(home, '.config', 'git-manager', 'folders.json'), 'utf-8'));
  assert.equal(rules.filter(r => r.path.endsWith('/client')).length, 1);
});

test('a repo-local account (gitm init) still beats the folder rule', () => {
  const repo = makeRepo('personal', 'pinned');
  run('git', ['config', '--local', 'user.email', 'pinned@repo.test'], repo);
  assert.equal(email(repo), 'pinned@repo.test');
});

test('list shows the rules and the account for the current folder', () => {
  const out = gitm(['list'], path.join(home, 'personal', 'a'));
  assert.match(out, /Folder rules/);
  assert.match(out, /This folder uses: Personal/);
});

test('unknown profile fails and changes nothing', () => {
  const before = fs.readFileSync(path.join(home, '.gitconfig'), 'utf-8');
  assert.throws(() => gitm(['folder', 'Nope'], path.join(home, 'elsewhere')));
  assert.equal(fs.readFileSync(path.join(home, '.gitconfig'), 'utf-8'), before);
});

test('--unset removes the rule and leaves other config alone', () => {
  run('git', ['config', '--global', 'includeIf.gitdir:/somewhere/else/.path', '/my/own.gitconfig'], home);

  gitm(['folder', '--unset'], path.join(home, 'personal', 'client'));
  gitm(['folder', '--unset'], path.join(home, 'personal'));

  assert.equal(email(path.join(home, 'personal', 'repo')), 'me@work.test');
  assert.equal(email(path.join(home, 'personal', 'client', 'repo')), 'me@work.test');

  const config = fs.readFileSync(path.join(home, '.gitconfig'), 'utf-8');
  assert.match(config, /\/my\/own\.gitconfig/, 'includeIf blocks not created by gitm are kept');
  assert.doesNotMatch(config, /git-manager\/profiles/);
  assert.equal(run('git', ['config', '--global', 'user.email'], home), 'me@work.test');
});
