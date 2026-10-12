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

## Notes

- Effects are client-side: only you see the buttons, everyone sees the normal bot commands.
- Client mods are against Discord's Terms of Service. Use at your own risk.

## License

GPL-3.0-or-later, same as Vencord.
