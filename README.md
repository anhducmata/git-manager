# @anhducmata/git-manager

> Instantly switch between multiple Git accounts (SSH keys + user config) on a single machine.

If you use **multiple GitHub/GitLab accounts** on one laptop (e.g. Work + Personal), this CLI tool lets you switch between them in seconds — including the SSH key, so `git push` always goes to the right account.

---

## ✨ Features

- **Per-repo config** — `gitm init` sets the account locally for each repo (recommended)
- **Global switch** — `gitm switch` changes the global config when you need it
- **Auto-generates SSH keys** — creates a dedicated `ed25519` key per profile
- **No more SSH conflicts** — uses `core.sshCommand` with `IdentitiesOnly=yes` so Git always uses the correct key
- **Interactive prompts** — no flags to memorize, just follow the menu
- **Lightweight** — zero config files to edit manually

---

## 📦 Installation

```bash
npm install -g @anhducmata/git-manager
```

After installing, the `gitm` command is available globally.

---

## 🚀 Quick Start

### 1. Add your first account

```bash
gitm new
```

You'll be asked for:
- **Profile name** — a label like `Work` or `Personal`
- **Git user.name** — the name that appears on your commits
- **Git user.email** — the email tied to your Git provider
- **SSH key** — press Enter to auto-generate a new `ed25519` key, or provide a path to an existing one

After the key is generated, the tool prints your **public key** so you can copy it into GitHub/GitLab:

```
ssh-ed25519 AAAAC3Nza... your-email@example.com
```

> 💡 Add this key to your Git provider:
> - **GitHub**: Settings → SSH and GPG keys → New SSH key
> - **GitLab**: Preferences → SSH Keys → Add new key

### 2. Add your second account

```bash
gitm new
```

Repeat the same process for your other account (e.g. `Personal`).

### 3. Set account per repo (recommended)

```bash
cd ~/projects/work-project
gitm init
```

This sets the Git user + SSH key **locally** for that repo only. Other repos are not affected.

### 4. Or switch globally

```bash
gitm switch
```

This changes the global Git config — useful when you want to quickly switch everything at once.

---

## 📖 Commands

| Command | Description |
|---|---|
| `gitm new` | Add a new Git account with SSH key |
| `gitm init` | Set account for current repo (local config) |
| `gitm switch` | Switch global git account |
| `gitm list` / `gitm ls` | Show all saved accounts + current active user |
| `gitm remove` | Remove a saved account (optionally delete its SSH key) |
| `gitm --help` | Show help |

---

## 🔧 How It Works

`gitm init` (local, per-repo) and `gitm switch` (global) both do the same three things:

```bash
# 1. Set Git identity
git config [--local|--global] user.name "Your Name"
git config [--local|--global] user.email "your@email.com"

# 2. Force Git to use the correct SSH key
git config [--local|--global] core.sshCommand "ssh -i ~/.ssh/id_ed25519_gm_work -o IdentitiesOnly=yes"
```

> 💡 **Tip:** Use `gitm init` per repo so each project is permanently tied to the right account. Use `gitm switch` only when you need a quick global change.

The `IdentitiesOnly=yes` flag is critical — it tells SSH to **only** use the specified key and ignore any other keys loaded in your SSH agent. This prevents the common problem where `git push` uses the wrong account.

---

## 📁 Where Data Is Stored

| Path | Contents |
|---|---|
| `~/.config/git-manager/accounts.json` | Your saved profiles |
| `~/.ssh/id_ed25519_gm_<profile>` | Auto-generated SSH private keys |
| `~/.ssh/id_ed25519_gm_<profile>.pub` | Auto-generated SSH public keys |

---

## ❓ FAQ

### Can I use an existing SSH key instead of generating a new one?

Yes! When `gitm new` asks for the SSH key path, just type the full path to your existing key instead of pressing Enter:

```
? Enter SSH key path: /Users/you/.ssh/id_rsa
```

### Should I use `gitm init` or `gitm switch`?

Use `gitm init` — it sets config **locally** per repo, so each project always uses the correct account. Use `gitm switch` only when you need a quick global change and don't want to configure each repo individually.

### What if I already have `~/.ssh/config` set up?

This tool uses `core.sshCommand` which overrides `~/.ssh/config` for Git operations. Your SSH config still works for non-Git SSH connections (like `ssh myserver`).

---

## 🤝 Contributing

PRs welcome! Feel free to open issues or submit pull requests.

## 📄 License

ISC
