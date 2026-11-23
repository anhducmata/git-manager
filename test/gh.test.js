import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'index.js');

let home;
let env;

function run(cmd, args, cwd, input) {
  return execFileSync(cmd, args, { cwd, env, input, stdio: [input ? 'pipe' : 'ignore', 'pipe', 'pipe'] }).toString().trim();
}
const gitm = (args, cwd) => run(process.execPath, [cli, ...args], cwd);
const configFile = name => path.join(home, '.config', 'git-manager', name);

function makeRepo(...parts) {
  const dir = path.join(home, ...parts);
  fs.mkdirSync(dir, { recursive: true });
  run('git', ['init', '-q'], dir);
  return dir;
}

// Runs `gh <args>` in a shell that has loaded the generated hook
function shellGh(shell, cwd, args = 'api user') {
  return spawnSync(shell, ['-c', `. "${configFile('gh.sh')}" && gh ${args}`], { cwd, env, encoding: 'utf-8' });
}

before(() => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gitm-gh-test-')));

  // Fake gh: knows the accounts "work-login" and "home-login"
  const bin = path.join(home, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'gh'), `#!/bin/sh
if [ "$1" = auth ] && [ "$2" = token ]; then
  for last; do :; done
  case "$last" in
    work-login|home-login) echo "token-of-$last"; exit 0 ;;
    *) echo "no oauth token found" >&2; exit 1 ;;
  esac
fi
if [ "$1" = auth ] && [ "$2" = status ]; then
  echo '{"hosts":{"github.com":[{"login":"home-login","active":true},{"login":"work-login","active":false}]}}'
  exit 0
fi
echo "ran: $* | token=\${GH_TOKEN:-none}"
`, { mode: 0o755 });

  env = { ...process.env, HOME: home, USERPROFILE: home, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', PATH: `${bin}${path.delimiter}${process.env.PATH}` };
  for (const key of ['GIT_CONFIG_GLOBAL', 'XDG_CONFIG_HOME', 'GH_TOKEN', 'GITHUB_TOKEN', 'GH_CONFIG_DIR', 'GIT_ASKPASS', 'SSH_ASKPASS']) {
    delete env[key];
  }

  fs.mkdirSync(path.dirname(configFile('x')), { recursive: true });
  fs.writeFileSync(configFile('accounts.json'), JSON.stringify([
    { profileName: 'Work', name: 'Work Me', email: 'me@work.test', sshKeyPath: '/keys/work' },
    { profileName: 'Personal', name: 'Home Me', email: 'me@home.test', sshKeyPath: '/keys/personal' }
  ]));
  run('git', ['config', '--global', 'user.email', 'me@home.test'], home);
  run('git', ['config', '--global', 'credential.helper', 'store --file=/nonexistent/global-store'], home);

  makeRepo('work', 'repo');
  makeRepo('work', 'client', 'repo');
  makeRepo('elsewhere', 'repo');
  gitm(['folder', 'Work'], path.join(home, 'work'));
});

after(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

test('without a gh account nothing gh-related is written', () => {
  assert.equal(fs.existsSync(configFile('gh.sh')), false);
  assert.equal(fs.existsSync(configFile('gh-folders')), false);
  assert.doesNotMatch(fs.readFileSync(configFile('profiles/work.gitconfig'), 'utf-8'), /credential/);
});

test('gitm gh links a profile and applies it to existing folder rules', () => {
  const out = gitm(['gh', 'work', 'work-login'], home);
  assert.match(out, /Applied to 1 folder rule/);

  const accounts = JSON.parse(fs.readFileSync(configFile('accounts.json'), 'utf-8'));
  assert.equal(accounts.find(a => a.profileName === 'Work').ghUser, 'work-login');
  assert.equal(fs.readFileSync(configFile('gh-folders'), 'utf-8'), `${path.join(home, 'work')}\twork-login\n`);
});

test('git over HTTPS uses the folder account inside, and only inside', () => {
  const ask = 'protocol=https\nhost=github.com\n\n';

  const inside = run('git', ['credential', 'fill'], path.join(home, 'work', 'client', 'repo'), ask);
  assert.match(inside, /^username=work-login$/m);
  assert.match(inside, /^password=token-of-work-login$/m);

  const helpersOutside = spawnSync('git', ['config', '--get-all', 'credential.https://github.com.helper'],
    { cwd: path.join(home, 'elsewhere', 'repo'), env, encoding: 'utf-8' });
  assert.equal(helpersOutside.stdout.trim(), '', 'no gitm helper outside the folder');
  assert.equal(run('git', ['config', 'credential.helper'], path.join(home, 'elsewhere', 'repo')), 'store --file=/nonexistent/global-store');
});

test('other hosts keep the global credential helper inside the folder', () => {
  const repo = path.join(home, 'work', 'repo');
  assert.equal(run('git', ['config', '--get-urlmatch', 'credential.helper', 'https://gitlab.com'], repo), 'store --file=/nonexistent/global-store');
});

for (const shell of ['zsh', 'bash']) {
  test(`${shell}: gh follows the folder, even outside a git repo`, { skip: spawnSync(shell, ['-c', 'true']).status !== 0 }, () => {
    const inFolder = shellGh(shell, path.join(home, 'work'));
    assert.equal(inFolder.stdout.trim(), 'ran: api user | token=token-of-work-login');

    const deep = shellGh(shell, path.join(home, 'work', 'client', 'repo'), 'pr list --label "two words"');
    assert.equal(deep.stdout.trim(), 'ran: pr list --label two words | token=token-of-work-login');

    const outside = shellGh(shell, path.join(home, 'elsewhere'));
    assert.equal(outside.stdout.trim(), 'ran: api user | token=none');

    fs.mkdirSync(path.join(home, 'work-other'), { recursive: true });
    assert.equal(shellGh(shell, path.join(home, 'work-other')).stdout.trim(), 'ran: api user | token=none');
  });

  test(`${shell}: gh auth and an explicit GH_TOKEN are left alone`, { skip: spawnSync(shell, ['-c', 'true']).status !== 0 }, () => {
    const auth = shellGh(shell, path.join(home, 'work'), 'auth switch');
    assert.equal(auth.stdout.trim(), 'ran: auth switch | token=none');

    const explicit = spawnSync(shell, ['-c', `. "${configFile('gh.sh')}" && GH_TOKEN=mine gh api user`],
      { cwd: path.join(home, 'work'), env, encoding: 'utf-8' });
    assert.equal(explicit.stdout.trim(), 'ran: api user | token=mine');
  });
}

test('an account that is not logged in fails loudly instead of using another one', () => {
  gitm(['gh', 'Personal', 'ghost-login'], home);
  gitm(['folder', 'Personal'], path.join(home, 'work', 'client'));

  const result = shellGh('sh', path.join(home, 'work', 'client', 'repo'));
  assert.notEqual(result.status, 0);
  assert.equal(result.stdout.trim(), '');
  assert.match(result.stderr, /'ghost-login', but it is not logged in/);

  const fill = spawnSync('git', ['credential', 'fill'],
    { cwd: path.join(home, 'work', 'client', 'repo'), env, input: 'protocol=https\nhost=github.com\n\n', encoding: 'utf-8' });
  assert.doesNotMatch(fill.stdout, /password=/);
  assert.match(fill.stderr, /'ghost-login' is not logged in/);

  // The parent folder is unaffected
  assert.equal(shellGh('sh', path.join(home, 'work', 'repo')).stdout.trim(), 'ran: api user | token=token-of-work-login');
});

test('a nested folder whose profile has no gh account does not inherit the parent account', () => {
  gitm(['gh', 'Personal', '--unset'], home);
  const nested = path.join(home, 'work', 'client', 'repo');

  assert.equal(shellGh('sh', nested).stdout.trim(), 'ran: api user | token=none');
  assert.equal(shellGh('sh', path.join(home, 'work', 'repo')).stdout.trim(), 'ran: api user | token=token-of-work-login');

  // git reads helpers in order and an empty value clears the list so far
  const helpers = run('git', ['config', '--get-all', 'credential.https://github.com.helper'], nested).split('\n');
  const effective = helpers.slice(helpers.lastIndexOf('') + 1);
  assert.deepEqual(effective, ['store --file=/nonexistent/global-store'], 'only the global helper is left');
  assert.equal(run('git', ['config', 'user.email'], nested), 'me@home.test');
});

test('rejects a login that is not a GitHub username', () => {
  assert.throws(() => gitm(['gh', 'Work', 'x; rm -rf ~'], home));
  const accounts = JSON.parse(fs.readFileSync(configFile('accounts.json'), 'utf-8'));
  assert.equal(accounts.find(a => a.profileName === 'Work').ghUser, 'work-login');
});

test('--unset removes the gh account and its files', () => {
  gitm(['gh', 'Personal', '--unset'], home);
  gitm(['gh', 'Work', '--unset'], home);

  assert.equal(fs.existsSync(configFile('gh.sh')), false);
  assert.equal(fs.existsSync(configFile('gh-folders')), false);
  assert.doesNotMatch(fs.readFileSync(configFile('profiles/work.gitconfig'), 'utf-8'), /credential/);
  assert.equal(run('git', ['config', 'user.email'], path.join(home, 'work', 'repo')), 'me@work.test');
});
