#!/usr/bin/env node

import { program } from 'commander';
import { input, select, confirm } from '@inquirer/prompts';
import chalk from 'chalk';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execSync } from 'child_process';

const configDir = path.join(os.homedir(), '.config', 'git-manager');
const accountsFile = path.join(configDir, 'accounts.json');

const __dirname = path.dirname(new URL(import.meta.url).pathname);
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
      console.log(`- ${chalk.green(acc.profileName)} (${acc.name} <${acc.email}>)`);
    });
    
    const current = getCurrentGitUser();
    console.log(`\n${chalk.bold('Current Global Git User:')} ${current.name} <${current.email}>`);
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

    const accounts = loadAccounts();
    accounts.push({ profileName, name, email, sshKeyPath: keyPathInput });
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
