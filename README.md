# VC Plugins for Vencord

Two [Vencord](https://github.com/Vendicated/Vencord) user plugins for people who manage temp voice channels with a voice-master bot (`.v`, `!v`, … commands).

- **VcQuickKick**: one-click kick/reject, bulk actions, permit, co-owner and a VC control panel
- **VcTagger**: tag users (e.g. "kicked me") and see the tag next to their name, with an alert when they join your VC

![Call view](screenshots/call-view.png)
![VC control panel](screenshots/control-panel.png)

## Features

### VcQuickKick
- **✕ button** next to every user in your VC (voice list *and* the big call cards). Left-click = reject (or kick), right-click = all actions
- **Right-click any user** anywhere → *VC actions*: reject, kick, text mute/unmute, permit, add co-owner, force mute/deafen (if you have the permission)
- **Bulk kick / reject**: tick people in your VC (or paste IDs), commands are batched 3 IDs per command
- **Permit**: permit by ID or from a "recently removed" list; the user gets pinged in the VC chat so they know they can rejoin
- **Add co-owner** (`.v cowner add <id>`)
- **VC control panel** (shield button in the chat bar): lock, unlock, hide, unhide, claim, rename, user limit
- **Auto-reject** people tagged with VcTagger when they join your VC
- **Join log** with avatars and pages, and a **"Meets"** counter (how many times you've been in a VC with someone)
- **Works on any server**: the bot prefix is auto-detected from chat, and you can set a prefix or custom command words per server (shield → *Server commands*)
- Your command messages are auto-deleted after a couple of seconds

### VcTagger
- Tag users with a label and see it next to their name in voice, the member list and chat
- Popup when a tagged user joins your VC
- Optionally treat users as tagged if your Discord note on them contains certain words

## Install

You need [Git](https://git-scm.com/), [Node.js](https://nodejs.org/) and [pnpm](https://pnpm.io/installation), and Vencord built from source.

```bash
git clone https://github.com/Vendicated/Vencord
cd Vencord
pnpm install
git clone https://github.com/1devaz/vc-plugins src/userplugins/vc-plugins
pnpm build
pnpm inject
```

Restart Discord, then enable **VcQuickKick** and **VcTagger** in *Settings → Vencord → Plugins*.

**Update:** run `git pull` inside `src/userplugins/vc-plugins`, then `pnpm build` and restart Discord.

## Setup for your server

Defaults use the `.v` prefix. If your server's bot uses something else (`!v`, `-vc`…), either just use any command once and it will be detected, or set it in **shield button → Server commands**. You can also change individual command words there.

## Security: what these plugins can and can't do

The repo is **source code only**: two small `.tsx` files and two `.css` files, no `.exe`, no `.dll`, no scripts, no minified or obfuscated code. You build it yourself with Vencord, so what you read is what runs.

| | |
|---|---|
| **Network** | Only Discord's own API, through Vencord's built-in Discord client. No `fetch`, no WebSockets, no outside servers, no analytics. |
| **Discord API calls** | `GET /guilds/{id}/application-command-index` (list a server's bot slash commands) · `PATCH /guilds/{id}/members/{id}` (server mute/deafen, only when you click it and Discord allows it) · `GET /users/@me/notes/{id}` (read *your own* note on a user, VcTagger) |
| **Messages** | Only the VC commands you trigger (e.g. `.v reject <id>`) and the permit ping, sent in your current VC chat |
| **Storage** | Vencord's local plugin settings + DataStore (your tags, "meets" count). Nothing leaves your PC. |
| **Your computer** | No file system access, no `eval`, no dynamic imports, no native code, no `child_process` |
| **Your account** | Never reads or touches your token, password or email |

**Check it yourself** in the repo folder. Each command should find nothing:

```bash
grep -rnE "fetch\(|XMLHttpRequest|WebSocket|eval\(|new Function|import\(|require\(|child_process|VencordNative|localStorage|token" vcQuickKick vcTagger
```
```bash
grep -rnoE "https?://[^\"' ]+" vcQuickKick vcTagger
```
The second one only shows `cdn.discordapp.com` (Discord's default avatars).

## Notes

- Effects are client-side: only you see the buttons, everyone sees the normal bot commands.
- Client mods are against Discord's Terms of Service. Use at your own risk.

## License

GPL-3.0-or-later, same as Vencord.
