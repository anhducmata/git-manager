#!/usr/bin/env node

import { program } from 'commander';
import { input, select, confirm } from '@inquirer/prompts';
import chalk from 'chalk';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execSync, execFileSync } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const configDir = path.join(os.homedir(), '.config', 'git-manager');
const accountsFile = path.join(configDir, 'accounts.json');
const foldersFile = path.join(configDir, 'folders.json');
const profilesDir = path.join(configDir, 'profiles');
const ghFoldersFile = path.join(configDir, 'gh-folders');
const ghShellFile = path.join(configDir, 'gh.sh');

const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf-8'));

// Ensure config dir exists
if (!fs.existsSync(configDir)) {
  fs.mkdirSync(configDir, { recursive: true });
}

// Load accounts
function loadAccounts() {
  if (!fs.existsSync(accountsFile)) {
    return [];
  }
  return JSON.parse(fs.readFileSync(accountsFile, 'utf-8'));
}

// Save accounts
function saveAccounts(accounts) {
  fs.writeFileSync(accountsFile, JSON.stringify(accounts, null, 2));
}

// Check current config
function getCurrentGitUser() {
  try {
    const name = execSync('git config --global user.name').toString().trim();
    const email = execSync('git config --global user.email').toString().trim();
    return { name, email };
  } catch (e) {
    return { name: 'Not set', email: 'Not set' };
  }
}

// ---------------------------------------------------------------------------
// Folder rules: one account for a folder and everything below it.
//
// Each rule becomes an `includeIf "gitdir:<folder>/"` block in the global git
// config that loads a small per-profile config file. Git only applies it to
// repos that live under that folder, so nothing outside is touched.
// ---------------------------------------------------------------------------

function git(args) {
  return execFileSync('git', args, { stdio: ['ignore', 'pipe', 'pipe'] }).toString();
}

function toPosix(p) {
  return p.replace(/\\/g, '/');
}

// Git matches `gitdir:` against the real path, so resolve symlinks first.
function normalizeFolder(dir) {
  let real = path.resolve(dir);
  try {
    real = fs.realpathSync.native(real);
  } catch (e) {
    // Folder may not exist any more (e.g. when removing an old rule)
  }
  real = toPosix(real);
  return real.length > 1 ? real.replace(/\/+$/, '') : real;
}

function loadFolders() {
  if (!fs.existsSync(foldersFile)) {
    return [];
  }
  return JSON.parse(fs.readFileSync(foldersFile, 'utf-8'));
}

function saveFolders(folders) {
  fs.writeFileSync(foldersFile, JSON.stringify(folders, null, 2));
}

function isInside(dir, folder) {
  const a = process.platform === 'linux' ? dir : dir.toLowerCase();
  const b = process.platform === 'linux' ? folder : folder.toLowerCase();
  return a === b || a.startsWith(b.endsWith('/') ? b : `${b}/`);
}

// The rule that applies to `dir`: the deepest folder rule containing it.
function findFolderRule(dir, folders = loadFolders()) {
  const target = normalizeFolder(dir);
  return folders
    .filter(f => isInside(target, f.path))
    .sort((a, b) => b.path.length - a.path.length)[0];
}

function profileConfigPath(profileName) {
  const safeName = profileName.toLowerCase().replace(/[^a-z0-9]/g, '_');
  return toPosix(path.join(profilesDir, `${safeName}.gitconfig`));
}

function includeSection(folder) {
  // macOS and Windows file systems are case-insensitive by default
  const condition = process.platform === 'linux' ? 'gitdir' : 'gitdir/i';
  return `includeIf.${condition}:${folder.endsWith('/') ? folder : `${folder}/`}`;
}

// Rewrite every gitm-managed includeIf block from folders.json.
// They are removed and re-added so they always sit at the END of the global
// config: git lets the last value win, so a folder rule must come after the
// global [user] section to override it.
function syncFolderRules() {
  const accounts = loadAccounts();
  const folders = loadFolders().filter(f => accounts.some(a => a.profileName === f.profileName));
  saveFolders(folders);

  // 1. Drop the blocks we manage (the ones pointing into our profiles dir)
  let existing = '';
  try {
    existing = git(['config', '--global', '-z', '--get-regexp', '^includeif\\..*\\.path$']);
  } catch (e) {
    // No includeIf entries yet
  }
  const managedPrefix = `${toPosix(profilesDir)}/`;
  const sections = new Set();
  existing.split('\0').filter(Boolean).forEach(entry => {
    const newline = entry.indexOf('\n');
    const key = entry.slice(0, newline);
    const value = toPosix(entry.slice(newline + 1));
    if (value.startsWith(managedPrefix)) {
      sections.add(`includeIf.${key.slice('includeif.'.length, -'.path'.length)}`);
    }
  });
  sections.forEach(section => {
    try {
      git(['config', '--global', '--remove-section', section]);
    } catch (e) {
      // Already gone
    }
  });

  // 2. Write one config file per profile in use
  fs.rmSync(profilesDir, { recursive: true, force: true });
  syncGhFiles(folders, accounts);
  if (folders.length === 0) {
    return;
  }
  fs.mkdirSync(profilesDir, { recursive: true });
  new Set(folders.map(f => f.profileName)).forEach(profileName => {
    const account = accounts.find(a => a.profileName === profileName);
    const file = profileConfigPath(profileName);
    git(['config', '-f', file, 'user.name', account.name]);
    git(['config', '-f', file, 'user.email', account.email]);
    git(['config', '-f', file, 'core.sshCommand', `ssh -i ${account.sshKeyPath} -o IdentitiesOnly=yes`]);
    if (account.ghUser) {
      // The empty value first clears helpers inherited from the global config
      git(['config', '-f', file, '--add', 'credential.https://github.com.helper', '']);
      git(['config', '-f', file, '--add', 'credential.https://github.com.helper', ghCredentialHelper(account.ghUser)]);
    } else if (nestedInGhFolder(profileName, folders, accounts)) {
      // A parent folder's gh account must not leak into this profile's folders:
      // clear it and put back the helpers from the global config.
      git(['config', '-f', file, '--add', 'credential.https://github.com.helper', '']);
      globalCredentialHelpers().forEach(helper => {
        git(['config', '-f', file, '--add', 'credential.https://github.com.helper', helper]);
      });
    }
  });

  // 3. Re-add, parents first so the deepest folder wins
  [...folders]
    .sort((a, b) => a.path.length - b.path.length)
    .forEach(f => {
      git(['config', '--global', '--add', `${includeSection(f.path)}.path`, profileConfigPath(f.profileName)]);
    });
}

// ---------------------------------------------------------------------------
// GitHub CLI (gh) support.
//
// A profile can carry a GitHub login (`ghUser`). gh keeps every logged-in
// account in its own store, so gitm never logs anyone in or out: it only asks
// gh for the token of the right account (`gh auth token --user <login>`).
//   - git over HTTPS: a credential helper in the per-profile config file
//   - the `gh` command: a small shell function (gh.sh) that picks the account
//     from the current folder
// ---------------------------------------------------------------------------

const GH_LOGIN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]*(_[A-Za-z0-9]+)?$/;

function ghCredentialHelper(login) {
  return `!f() { test "$1" = get || exit 0; t=$(gh auth token --hostname github.com --user ${login}) || `
    + `{ echo "gitm: gh account '${login}' is not logged in. Run: gh auth login" >&2; exit 1; }; `
    + `echo username=${login}; echo "password=$t"; }; f`;
}

const GH_SHELL_HOOK = `# Generated by gitm (git-manager). Do not edit: it is rewritten by \`gitm folder\`.
# Makes the gh CLI use the GitHub account of the folder you are in.
gh() {
  local _gitm_user="" _gitm_dir _gitm_path _gitm_login _gitm_token
  local _gitm_map="\${HOME}/.config/git-manager/gh-folders"
  if [ "\$1" != "auth" ] && [ -z "\${GH_TOKEN:-}" ] && [ -z "\${GITHUB_TOKEN:-}" ] && [ -r "\$_gitm_map" ]; then
    _gitm_dir="\$(pwd -P)"
    while IFS="	" read -r _gitm_path _gitm_login; do
      case "\$_gitm_dir/" in
        "\$_gitm_path"/*) [ "\$_gitm_login" != "-" ] && _gitm_user="\$_gitm_login"; break ;;
      esac
    done < "\$_gitm_map"
  fi
  if [ -z "\$_gitm_user" ]; then
    command gh "\$@"
    return
  fi
  if ! _gitm_token="\$(command gh auth token --hostname github.com --user "\$_gitm_user" 2>/dev/null)"; then
    echo "gitm: this folder uses the gh account '\$_gitm_user', but it is not logged in. Run: gh auth login" >&2
    return 1
  fi
  GH_TOKEN="\$_gitm_token" command gh "\$@"
}
`;

// Logins that gh already has for github.com (empty when gh is missing)
function ghLoggedInUsers() {
  try {
    const out = execFileSync('gh', ['auth', 'status', '--json', 'hosts'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString();
    return (JSON.parse(out).hosts?.['github.com'] || []).map(h => h.login).filter(Boolean);
  } catch (e) {
    return [];
  }
}

function ghIsLoggedIn(login) {
  try {
    execFileSync('gh', ['auth', 'token', '--hostname', 'github.com', '--user', login], { stdio: 'ignore' });
    return true;
  } catch (e) {
    return false;
  }
}

function ghShellHookInstalled() {
  return ['.zshrc', '.bashrc', '.bash_profile', '.zprofile', '.profile'].some(rc => {
    try {
      return fs.readFileSync(path.join(os.homedir(), rc), 'utf-8').includes('git-manager/gh.sh');
    } catch (e) {
      return false;
    }
  });
}

// Is one of this profile's folders inside a folder whose profile has a gh account?
function nestedInGhFolder(profileName, folders, accounts) {
  const ghFolders = folders.filter(f => accounts.find(a => a.profileName === f.profileName)?.ghUser);
  return folders
    .filter(f => f.profileName === profileName)
    .some(f => ghFolders.some(g => g.path !== f.path && isInside(f.path, g.path)));
}

// Credential helpers that apply when no folder rule does (Git's built-in,
// system and global config), read from a place no rule can match.
function globalCredentialHelpers() {
  const managedPrefix = `file:${toPosix(profilesDir)}/`;
  return ['credential.helper', 'credential.https://github.com.helper'].flatMap(key => {
    try {
      const out = execFileSync('git', ['config', '--show-origin', '--get-all', key], {
        cwd: path.parse(os.homedir()).root,
        env: { ...process.env, GIT_DIR: undefined, GIT_CEILING_DIRECTORIES: path.parse(os.homedir()).root },
        stdio: ['ignore', 'pipe', 'ignore']
      }).toString();
      return out.split('\n')
        .map(line => line.split('\t'))
        .filter(([origin, value]) => value && !toPosix(origin).startsWith(managedPrefix))
        .map(([, value]) => value);
    } catch (e) {
      return [];
    }
  });
}

// Write the folder → gh login map and the shell function that reads it
function syncGhFiles(folders, accounts) {
  const lines = [...folders]
    .sort((a, b) => b.path.length - a.path.length) // deepest first: first match wins
    // "-" = this folder has a rule but no gh account: do not inherit the parent folder's
    .map(f => ({ path: f.path, login: accounts.find(a => a.profileName === f.profileName)?.ghUser || '-' }))
    .map(f => `${f.path}\t${f.login}`);

  if (lines.every(line => line.endsWith('\t-'))) {
    fs.rmSync(ghFoldersFile, { force: true });
    fs.rmSync(ghShellFile, { force: true });
    return;
  }
  fs.writeFileSync(ghFoldersFile, `${lines.join('\n')}\n`);
  fs.writeFileSync(ghShellFile, GH_SHELL_HOOK);
}

function printGhStatus(account) {
  if (!account.ghUser) {
    console.log(chalk.gray(`gh:     not set — run \`gitm gh\` to make the gh CLI follow this profile too`));
    return;
  }
  console.log(chalk.cyan(`gh:     ${account.ghUser}`));
  if (!ghIsLoggedIn(account.ghUser)) {
    console.log(chalk.yellow(`\n'${account.ghUser}' is not logged in to gh yet. Run: gh auth login`));
    console.log(chalk.gray('(gh keeps your other accounts; switch the default back with `gh auth switch`)'));
  }
  if (!ghShellHookInstalled()) {
    console.log(chalk.yellow('\nTo make the `gh` command follow folder rules, add this line to your ~/.zshrc or ~/.bashrc:'));
    console.log(`  [ -f ~/.config/git-manager/gh.sh ] && . ~/.config/git-manager/gh.sh`);
  }
}

function printFolderRules(folders) {
  console.log(chalk.bold('\nFolder rules (folder + all sub-folders):'));
  const accounts = loadAccounts();
  folders.forEach(f => {
    const ghUser = accounts.find(a => a.profileName === f.profileName)?.ghUser;
    console.log(`- ${chalk.cyan(f.path)} → ${chalk.green(f.profileName)}${ghUser ? chalk.gray(` (gh: ${ghUser})`) : ''}`);
  });
}

program
  .name('gitm')
  .description('Git Account Manager CLI')
  .version(pkg.version);

program
  .command('list')
  .alias('ls')
  .description('List all available git accounts')
  .action(() => {
    const accounts = loadAccounts();
    if (accounts.length === 0) {
      console.log(chalk.yellow('No accounts found. Add one with `gitm new`.'));
      return;
    }
    console.log(chalk.bold('\nAvailable Git Accounts:'));
    accounts.forEach(acc => {
      const ghInfo = acc.ghUser ? chalk.gray(` gh: ${acc.ghUser}`) : '';
      console.log(`- ${chalk.green(acc.profileName)} (${acc.name} <${acc.email}>)${ghInfo}`);
    });
    
    const current = getCurrentGitUser();
    console.log(`\n${chalk.bold('Current Global Git User:')} ${current.name} <${current.email}>`);

    const folders = loadFolders();
    if (folders.length > 0) {
      printFolderRules(folders);
      const rule = findFolderRule(process.cwd(), folders);
      if (rule) {
        console.log(`\n${chalk.bold('This folder uses:')} ${chalk.green(rule.profileName)} (rule on ${rule.path})`);
      }
    }
  });

program
  .command('new')
  .description('Add a new git account')
  .action(async () => {
    console.log(chalk.cyan('Creating a new Git profile...\n'));
    
    const profileName = await input({ message: 'Enter a profile name (e.g. Work, Personal):' });
    const name = await input({ message: 'Enter your Git user.name (e.g. John Doe):' });
    const email = await input({ message: 'Enter your Git user.email (e.g. john@example.com):' });
    
    const sshDir = path.join(os.homedir(), '.ssh');
    if (!fs.existsSync(sshDir)) {
      fs.mkdirSync(sshDir, { recursive: true, mode: 0o700 });
    }
    
    const safeName = profileName.toLowerCase().replace(/[^a-z0-9]/g, '_');
    const defaultKeyName = `id_ed25519_gm_${safeName}`;
    const defaultKeyPath = path.join(sshDir, defaultKeyName);

    const keyPathInput = await input({ 
      message: 'Enter SSH key path (or press enter to generate a new ed25519 key):',
      default: defaultKeyPath
    });

    const isNewKey = keyPathInput === defaultKeyPath && !fs.existsSync(keyPathInput);
    
    if (isNewKey) {
      console.log(chalk.blue(`Generating new SSH key at ${keyPathInput}...`));
      try {
        execSync(`ssh-keygen -t ed25519 -C "${email}" -f "${keyPathInput}" -N ""`, { stdio: 'inherit' });
        console.log(chalk.green('SSH key generated successfully!'));
        console.log(chalk.yellow('\nMake sure to add the following public key to your Git provider (GitHub/GitLab/etc):\n'));
        console.log(fs.readFileSync(`${keyPathInput}.pub`, 'utf-8'));
      } catch (error) {
        console.log(chalk.red('Error generating SSH key. Continuing with path setup.'));
      }
    }

    const ghUser = (await input({
      message: 'GitHub username for the gh CLI (optional, press enter to skip):',
      validate: v => v.trim() === '' || GH_LOGIN_PATTERN.test(v.trim()) || 'That does not look like a GitHub username.'
    })).trim();

    const accounts = loadAccounts();
    const newAccount = { profileName, name, email, sshKeyPath: keyPathInput };
    if (ghUser) {
      newAccount.ghUser = ghUser;
    }
    accounts.push(newAccount);
    saveAccounts(accounts);
    
    console.log(chalk.green(`\nProfile '${profileName}' added successfully!`));
    
    const switchNow = await confirm({ message: 'Do you want to switch to this profile now?' });
    if (switchNow) {
      switchAccount(profileName, accounts);
    }
  });

function switchAccount(profileName, accounts) {
  const account = accounts.find(a => a.profileName === profileName);
  if (!account) {
    console.log(chalk.red(`Profile '${profileName}' not found.`));
    return;
  }
  
  try {
    execSync(`git config --global user.name "${account.name}"`);
    execSync(`git config --global user.email "${account.email}"`);
    // Crucial: Use core.sshCommand to override SSH completely for this git global context!
    execSync(`git config --global core.sshCommand "ssh -i ${account.sshKeyPath} -o IdentitiesOnly=yes"`);
    // Keep folder rules below the global [user] section so they still win
    syncFolderRules();

    console.log(chalk.green(`\nSuccessfully switched to profile '${account.profileName}'!`));
    console.log(chalk.cyan(`User:  ${account.name}`));
    console.log(chalk.cyan(`Email: ${account.email}`));
    console.log(chalk.cyan(`SSH:   ${account.sshKeyPath}`));
  } catch (error) {
    console.log(chalk.red('Failed to switch account:', error.message));
  }
}

program
  .command('switch')
  .description('Switch global git account')
  .action(async () => {
    const accounts = loadAccounts();
    if (accounts.length === 0) {
      console.log(chalk.yellow('No accounts found. Add one with `gitm new`.'));
      return;
    }
    
    const current = getCurrentGitUser();
    console.log(chalk.blue(`Current global user: ${current.name} <${current.email}>\n`));
    
    const choices = accounts.map(acc => ({
      name: `${acc.profileName} (${acc.name} <${acc.email}>)`,
      value: acc.profileName
    }));
    
    const selectedProfile = await select({
      message: 'Select an account to switch to (global):',
      choices
    });
    
    switchAccount(selectedProfile, accounts);
  });

program
  .command('init')
  .description('Set git account for the current repo (local config)')
  .action(async () => {
    // Check if we're in a git repo
    try {
      execSync('git rev-parse --git-dir', { stdio: 'ignore' });
    } catch (e) {
      console.log(chalk.red('Not a git repository. Run this inside a git project.'));
      return;
    }

    const accounts = loadAccounts();
    if (accounts.length === 0) {
      console.log(chalk.yellow('No accounts found. Add one with `gitm new`.'));
      return;
    }

    // Show current local config if any
    try {
      const localName = execSync('git config --local user.name').toString().trim();
      const localEmail = execSync('git config --local user.email').toString().trim();
      console.log(chalk.blue(`Current local config: ${localName} <${localEmail}>\n`));
    } catch (e) {
      console.log(chalk.gray('No local git config set for this repo yet.\n'));
    }

    const choices = accounts.map(acc => ({
      name: `${acc.profileName} (${acc.name} <${acc.email}>)`,
      value: acc.profileName
    }));

    const selectedProfile = await select({
      message: 'Select an account for this repo:',
      choices
    });

    const account = accounts.find(a => a.profileName === selectedProfile);

    try {
      execSync(`git config --local user.name "${account.name}"`);
      execSync(`git config --local user.email "${account.email}"`);
      execSync(`git config --local core.sshCommand "ssh -i ${account.sshKeyPath} -o IdentitiesOnly=yes"`);

      console.log(chalk.green(`\nThis repo is now using profile '${account.profileName}'!`));
      console.log(chalk.cyan(`User:  ${account.name}`));
      console.log(chalk.cyan(`Email: ${account.email}`));
      console.log(chalk.cyan(`SSH:   ${account.sshKeyPath}`));
      console.log(chalk.gray('\nThis config is local — it won\'t affect other repos.'));
    } catch (error) {
      console.log(chalk.red('Failed to set local config:', error.message));
    }
  });

program
  .command('folder [profile]')
  .alias('dir')
  .description('Set git account for the current folder and all its sub-folders')
  .option('-u, --unset', 'remove the rule set on the current folder')
  .option('-l, --list', 'list all folder rules')
  .action(async (profile, options) => {
    const folder = normalizeFolder(process.cwd());
    let folders = loadFolders();

    if (options.list) {
      if (folders.length === 0) {
        console.log(chalk.yellow('No folder rules yet. Run `gitm folder` inside a folder to add one.'));
        return;
      }
      printFolderRules(folders);
      return;
    }

    const existing = folders.find(f => f.path === folder);

    if (options.unset) {
      if (!existing) {
        console.log(chalk.yellow(`No folder rule is set on ${folder}.`));
        return;
      }
      saveFolders(folders.filter(f => f.path !== folder));
      syncFolderRules();
      console.log(chalk.green(`Removed folder rule on ${folder}.`));
      return;
    }

    const accounts = loadAccounts();
    if (accounts.length === 0) {
      console.log(chalk.yellow('No accounts found. Add one with `gitm new`.'));
      return;
    }

    if (folder === normalizeFolder(os.homedir()) || folder === '/') {
      console.log(chalk.red('This folder is too broad for a folder rule. Use `gitm switch` to change the global account.'));
      return;
    }

    const inherited = findFolderRule(folder, folders);
    if (existing) {
      console.log(chalk.blue(`This folder currently uses: ${existing.profileName}\n`));
    } else if (inherited) {
      console.log(chalk.blue(`Inherited from ${inherited.path}: ${inherited.profileName}\n`));
    } else {
      console.log(chalk.gray('No folder rule here yet (the global account applies).\n'));
    }

    let selectedProfile = profile;
    if (selectedProfile) {
      const match = accounts.find(a => a.profileName.toLowerCase() === selectedProfile.toLowerCase());
      if (!match) {
        console.log(chalk.red(`Profile '${selectedProfile}' not found. See \`gitm list\`.`));
        process.exitCode = 1;
        return;
      }
      selectedProfile = match.profileName;
    } else {
      selectedProfile = await select({
        message: `Select an account for ${folder} and all its sub-folders:`,
        choices: accounts.map(acc => ({
          name: `${acc.profileName} (${acc.name} <${acc.email}>)`,
          value: acc.profileName
        }))
      });
    }

    const account = accounts.find(a => a.profileName === selectedProfile);

    try {
      folders = folders.filter(f => f.path !== folder);
      folders.push({ path: folder, profileName: account.profileName });
      saveFolders(folders);
      syncFolderRules();

      console.log(chalk.green(`\nRepos under this folder now use profile '${account.profileName}'!`));
      console.log(chalk.cyan(`Folder: ${folder}`));
      console.log(chalk.cyan(`User:   ${account.name}`));
      console.log(chalk.cyan(`Email:  ${account.email}`));
      console.log(chalk.cyan(`SSH:    ${account.sshKeyPath}`));
      printGhStatus(account);
      console.log(chalk.gray('\nRepos outside this folder are not affected.'));
      console.log(chalk.gray('A repo set up with `gitm init` keeps its own account.'));
    } catch (error) {
      console.log(chalk.red('Failed to set folder rule:', error.message));
      process.exitCode = 1;
    }
  });

program
  .command('gh [profile] [login]')
  .description('Link a profile to a GitHub CLI (gh) account, used by its folder rules')
  .option('-u, --unset', 'remove the gh account from the profile')
  .action(async (profile, login, options) => {
    const accounts = loadAccounts();
    if (accounts.length === 0) {
      console.log(chalk.yellow('No accounts found. Add one with `gitm new`.'));
      return;
    }

    let account;
    if (profile) {
      account = accounts.find(a => a.profileName.toLowerCase() === profile.toLowerCase());
      if (!account) {
        console.log(chalk.red(`Profile '${profile}' not found. See \`gitm list\`.`));
        process.exitCode = 1;
        return;
      }
    } else {
      const selected = await select({
        message: 'Select a profile:',
        choices: accounts.map(acc => ({
          name: `${acc.profileName} (${acc.name} <${acc.email}>)${acc.ghUser ? ` gh: ${acc.ghUser}` : ''}`,
          value: acc.profileName
        }))
      });
      account = accounts.find(a => a.profileName === selected);
    }

    if (options.unset) {
      delete account.ghUser;
      saveAccounts(accounts);
      syncFolderRules();
      console.log(chalk.green(`Profile '${account.profileName}' no longer has a gh account.`));
      return;
    }

    let ghUser = login;
    if (!ghUser) {
      const loggedIn = ghLoggedInUsers();
      const OTHER = '\0other';
      let picked = OTHER;
      if (loggedIn.length > 0) {
        picked = await select({
          message: `GitHub account for '${account.profileName}':`,
          choices: [
            ...loggedIn.map(l => ({ name: `${l} (logged in to gh)`, value: l })),
            { name: 'Another account…', value: OTHER }
          ],
          default: account.ghUser
        });
      }
      ghUser = picked === OTHER
        ? await input({ message: 'GitHub username:', default: account.ghUser })
        : picked;
    }

    ghUser = (ghUser || '').trim();
    if (!GH_LOGIN_PATTERN.test(ghUser)) {
      console.log(chalk.red(`'${ghUser}' does not look like a GitHub username.`));
      process.exitCode = 1;
      return;
    }

    account.ghUser = ghUser;
    saveAccounts(accounts);
    syncFolderRules();

    console.log(chalk.green(`\nProfile '${account.profileName}' now uses the gh account '${ghUser}'.`));
    const ruleCount = loadFolders().filter(f => f.profileName === account.profileName).length;
    console.log(chalk.gray(ruleCount > 0
      ? `Applied to ${ruleCount} folder rule(s).`
      : 'It takes effect in folders you assign with `gitm folder`.'));
    printGhStatus(account);
  });

program
  .command('remove')
  .description('Remove a git account')
  .action(async () => {
    const accounts = loadAccounts();
    if (accounts.length === 0) {
      console.log(chalk.yellow('No accounts found.'));
      return;
    }
    
    const choices = accounts.map(acc => ({
      name: `${acc.profileName} (${acc.name} <${acc.email}>)`,
      value: acc.profileName
    }));
    
    const selectedProfile = await select({
      message: 'Select an account to remove:',
      choices
    });
    
    const account = accounts.find(a => a.profileName === selectedProfile);
    
    const confirmDelete = await confirm({ 
      message: chalk.red(`Are you sure you want to remove '${selectedProfile}'?`) 
    });
    
    if (confirmDelete) {
      const remaining = accounts.filter(a => a.profileName !== selectedProfile);
      saveAccounts(remaining);
      console.log(chalk.green(`Profile '${selectedProfile}' removed.`));

      const orphaned = loadFolders().filter(f => f.profileName === selectedProfile);
      if (orphaned.length > 0) {
        syncFolderRules();
        console.log(chalk.yellow(`Removed ${orphaned.length} folder rule(s) that used it.`));
      }
      
      try {
        if (fs.existsSync(account.sshKeyPath)) {
          const deleteKey = await confirm({ 
            message: `Do you also want to delete the SSH key at ${account.sshKeyPath}?`, 
            default: false 
          });
          if (deleteKey) {
            fs.unlinkSync(account.sshKeyPath);
            if (fs.existsSync(`${account.sshKeyPath}.pub`)) {
              fs.unlinkSync(`${account.sshKeyPath}.pub`);
            }
            console.log(chalk.green('SSH key deleted.'));
          }
        }
      } catch (e) {
        // Ignored
      }
    }
  });

program.parse(process.argv);
