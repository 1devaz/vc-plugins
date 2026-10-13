/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./style.css";

import { ChatBarButton, ChatBarButtonFactory } from "@api/ChatButtons";
import { NavContextMenuPatchCallback } from "@api/ContextMenu";
import * as DataStore from "@api/DataStore";
import { definePluginSettings } from "@api/Settings";
import ErrorBoundary from "@components/ErrorBoundary";
import { sendMessage } from "@utils/discord";
import { Logger } from "@utils/Logger";
import definePlugin, { IconProps, OptionType } from "@utils/types";
import type { RenderModalProps, User } from "@vencord/discord-types";
import {
    ChannelStore, ContextMenuApi, GuildStore, FluxDispatcher, Menu, MessageActions, Modal, openModal, PermissionsBits, PermissionStore, RestAPI, SelectedChannelStore,
    showToast, Text, TextInput, Tooltip, UserStore, useEffect, useState, useStateFromStores, VoiceStateStore
} from "@webpack/common";

const logger = new Logger("VcQuickKick");
/** deep plain copy: settings.store hands out live proxies, and proxies can't be saved to disk ("could not be cloned") */
const plain = <T,>(v: T): T => JSON.parse(JSON.stringify(v ?? {}));

/** Discord's newer TextInput sometimes calls onChange with an event instead of the text */
const inputText = (v: any): string => typeof v === "string" ? v : v?.currentTarget?.value ?? v?.target?.value ?? "";

// ---------- settings ----------

const cmd = (description: string, def: string) => ({ type: OptionType.STRING as const, description, default: def });

const settings = definePluginSettings({
    action: {
        type: OptionType.SELECT,
        description: "What a left-click on the ✕ button does (right-click it for all actions)",
        options: [
            { label: "Reject (kick + can't rejoin)", value: "reject", default: true },
            { label: "Kick", value: "kick" }
        ]
    },
    autoReject: {
        type: OptionType.BOOLEAN,
        description: "Automatically reject people tagged with VcTagger when they join your VC",
        default: true
    },
    autoRejectOnlyWhenOwner: {
        type: OptionType.BOOLEAN,
        description: "Only auto-reject in VCs you created (where you're the first one in / you claimed it). Turn off to always try",
        default: false
    },
    deleteDelay: {
        type: OptionType.NUMBER,
        description: "Seconds before your command message is deleted (give the bot time to read it)",
        default: 2
    },
    tileButton: {
        type: OptionType.BOOLEAN,
        description: "Show the ✕ button in the corner of each member square (the big cards in the call view)",
        default: true
    },
    alsoTag: {
        type: OptionType.BOOLEAN,
        description: "When you reject/kick someone with the button, also tag them in VcTagger",
        default: false
    },
    defaultPrefix: cmd("Default bot prefix ({p} in the commands below). Set a different one per server from the shield button → Server commands", ".v"),
    serverCommands: {
        type: OptionType.CUSTOM,
        default: {} as Record<string, ServerConfig>
    },
    kickCommand: cmd("Kick command ({p} = prefix, {id} = user ID)", "{p} kick {id}"),
    rejectCommand: cmd("Reject command", "{p} reject {id}"),
    muteCommand: cmd("Text-mute command (mutes their chat in your VC)", "{p} tmute {id}"),
    unmuteCommand: cmd("Text-unmute command", "{p} tunmute {id}"),
    permitCommand: cmd("Permit command", "{p} permit {id}"),
    permitMessage: cmd("Message sent after permitting someone, so they get pinged ({id} = user ID, leave empty to disable)", "<@{id}> you've been permitted, you can rejoin the VC now 👋"),
    cownerCommand: cmd("Add co-owner command", "{p} cowner add {id}"),
    bulkDelay: {
        type: OptionType.NUMBER,
        description: "Seconds between commands when bulk kicking/rejecting (so the bot doesn't rate-limit you)",
        default: 1.5
    },
    bulkPerCommand: {
        type: OptionType.NUMBER,
        description: "How many user IDs the bot accepts in one kick/reject command (bulk sends e.g. .v reject id1 id2 id3)",
        default: 3
    },
    lockCommand: cmd("Lock command", "{p} lock"),
    unlockCommand: cmd("Unlock command", "{p} unlock"),
    hideCommand: cmd("Hide command", "{p} hide"),
    unhideCommand: cmd("Unhide command", "{p} unhide"),
    claimCommand: cmd("Claim command", "{p} claim"),
    nameCommand: cmd("Rename command ({text} = new name)", "{p} name {text}"),
    limitCommand: cmd("User limit command ({text} = number)", "{p} limit {text}")
});

interface ServerConfig { prefix?: string; commands?: Record<string, string>; detected?: string; detectedBot?: string; }

type UserAction = "kick" | "reject" | "mute" | "unmute" | "permit" | "cowner";
type ChannelAction = "lock" | "unlock" | "hide" | "unhide" | "claim" | "name" | "limit";

const USER_ACTIONS: { id: UserAction; label: string; danger?: boolean; }[] = [
    { id: "reject", label: "Reject", danger: true },
    { id: "kick", label: "Kick", danger: true },
    { id: "mute", label: "Text mute (chat)" },
    { id: "unmute", label: "Text unmute (chat)" },
    { id: "permit", label: "Permit (allow in)" },
    { id: "cowner", label: "Add co-owner" }
];

const PAST: Record<UserAction, string> = { kick: "Kicked", reject: "Rejected", mute: "Text-muted", unmute: "Text-unmuted", permit: "Permitted", cowner: "Made co-owner:" };

// ---------- sending + auto-delete ----------

const pendingDeletes = new Map<string, number>(); // "channelId|content" -> expiry

const COMMAND_KEYS: { key: string; label: string; }[] = [
    { key: "kick", label: "Kick" }, { key: "reject", label: "Reject" }, { key: "mute", label: "Text mute" }, { key: "unmute", label: "Text unmute" },
    { key: "permit", label: "Permit" }, { key: "cowner", label: "Add co-owner" }, { key: "lock", label: "Lock" }, { key: "unlock", label: "Unlock" },
    { key: "hide", label: "Hide" }, { key: "unhide", label: "Unhide" }, { key: "claim", label: "Claim" }, { key: "name", label: "Rename" }, { key: "limit", label: "User limit" }
];

const currentGuildId = () => ChannelStore.getChannel(SelectedChannelStore.getVoiceChannelId()!)?.guild_id ?? null;

/** command template for the server you're in voice on: per-server override → global, with {p} / leading .v swapped for that server's prefix */
function getCommand(key: string, guildId = currentGuildId()): string {
    const cfg: ServerConfig = (guildId && settings.store.serverCommands?.[guildId]) || {};
    const tpl = cfg.commands?.[key]?.trim() || (settings.store[`${key}Command`] as string);
    const prefix = cfg.prefix?.trim() || cfg.detected || settings.store.defaultPrefix?.trim() || ".v";
    return tpl.replace(/^(\{p\}|\.v)(?=\s|$)/, prefix).replaceAll("{p}", prefix);
}

function sendCommand(content: string): boolean {
    const channelId = SelectedChannelStore.getVoiceChannelId();
    if (!channelId) {
        showToast("You're not in a voice channel", "failure");
        return false;
    }
    pendingDeletes.set(`${channelId}|${content}`, Date.now() + 30_000);
    sendMessage(channelId, { content });
    return true;
}

// ---------- prefix auto-detect: someone sends "<prefix> <vc verb> ..." and a bot answers within a few seconds ----------

const VC_VERBS = "kick|reject|permit|lock|unlock|hide|unhide|claim|unclaim|limit|name|rename|tmute|tunmute|cowner|owner|transfer|ban|unban|mute|unmute|invite|sb|soundboard|activity|activities|status|bitrate";
const CANDIDATE_RE = new RegExp(`^(\\S{1,6})\\s+(?:${VC_VERBS})\\b`, "i");
/** channelId -> candidate prefix waiting for a bot reply */
const candidates = new Map<string, { prefix: string; until: number; }>();

function learnPrefix(message: any) {
    const channel = ChannelStore.getChannel(message.channel_id);
    const guildId = channel?.guild_id;
    if (!guildId) return;

    if (!message.author?.bot) {
        const prefix = message.content?.match(CANDIDATE_RE)?.[1];
        // a real prefix has a symbol in it (.v  !v  -vc  v!) — skips normal sentences like "pls kick him"
        if (prefix && /[^a-z0-9]/i.test(prefix) && !/^<[@#]/.test(prefix)) candidates.set(message.channel_id, { prefix, until: Date.now() + 8000 });
        return;
    }

    const cand = candidates.get(message.channel_id);
    if (!cand || cand.until < Date.now()) return;
    candidates.delete(message.channel_id);

    const all: Record<string, ServerConfig> = plain(settings.store.serverCommands);
    const cfg: ServerConfig = all[guildId] ?? {};
    if (cfg.detected === cand.prefix && cfg.detectedBot === message.author.id) return;
    all[guildId] = { ...cfg, detected: cand.prefix, detectedBot: message.author.id };
    settings.store.serverCommands = all;

    if (!cfg.prefix) showToast(`Detected ${cand.prefix} as the VC bot prefix for ${GuildStore.getGuild(guildId)?.name ?? "this server"}`, "success");
}

function onMessageCreate({ message, optimistic }: { message: any; optimistic?: boolean; }) {
    if (optimistic || !message?.id || !message.channel_id) return;
    try { learnPrefix(message); } catch (e) { logger.error("prefix detect failed", e); }
    if (message.author?.id !== UserStore.getCurrentUser()?.id) return;

    const key = `${message.channel_id}|${message.content}`;
    const expiry = pendingDeletes.get(key);
    if (!expiry) return;
    pendingDeletes.delete(key);
    if (expiry < Date.now()) return;

    setTimeout(() => MessageActions.deleteMessage(message.channel_id, message.id), Math.max(0, settings.store.deleteDelay) * 1000);
}

const displayName = (user?: User | null, fallback = "?") => (user as any)?.globalName ?? user?.username ?? fallback;

/** userId -> time, people you kicked/rejected this session (newest last) */
const removed = new Map<string, { kind: "kick" | "reject"; time: number; }>();
/** userId -> when you permitted them. Auto-reject skips them unless they were tagged AFTER that */
const permitted = new Map<string, number>();

function permitId(id: string): boolean {
    const template = getCommand("permit");
    if (!sendCommand(template.replaceAll("{id}", id))) return false;
    removed.delete(id);
    permitted.set(id, Date.now());
    const msg = (settings.store.permitMessage as string)?.trim();
    const channelId = SelectedChannelStore.getVoiceChannelId();
    if (msg && channelId) setTimeout(() => sendMessage(channelId, { content: msg.replaceAll("{id}", id) }), 800);
    showToast(`Permitted ${displayName(UserStore.getUser(id), id)}`, "success");
    return true;
}

function runUserAction(kind: UserAction, user: User, auto = false) {
    if (kind === "permit") { permitId(user.id); return; }
    const template = getCommand(kind);
    if (!sendCommand(template.replaceAll("{id}", user.id))) return;
    if (kind === "kick" || kind === "reject") noteRemoved(kind, user.id, !auto);
    showToast(`${auto ? "Auto-" : ""}${PAST[kind].toLowerCase().replace(/^./, c => auto ? c : c.toUpperCase())} ${displayName(user)}`, auto ? "failure" : "success");
}

/** bookkeeping after a kick/reject: recent list, permit list, optional VcTagger tag */
function noteRemoved(kind: "kick" | "reject", id: string, tag: boolean) {
    permitted.delete(id);
    removed.delete(id);
    removed.set(id, { kind, time: Date.now() });
    if (removed.size > 25) removed.delete(removed.keys().next().value!);

    if (tag && settings.store.alsoTag) {
        const s = Vencord.Settings.plugins.VcTagger;
        if (Vencord.Plugins.plugins.VcTagger?.started && !s.tags?.[id])
            s.tags = { ...plain(s.tags), [id]: { label: kind === "kick" ? "KICKED" : "REJECTED", date: Date.now() } };
    }
}

function runChannelAction(kind: ChannelAction, text?: string) {
    const template = getCommand(kind);
    if (sendCommand(template.replaceAll("{text}", text ?? ""))) showToast(`Sent: ${kind}${text ? ` ${text}` : ""}`, "success");
}

// ---------- seen-before history (#5) ----------

interface Seen { count: number; last: number; channel: string; }
const SEEN_KEY = "VcQuickKick_meets";
let seen: Record<string, Seen> = {};
let seenDirty = false;
const MEET_MS = 2 * 60 * 1000;
/** userId -> timer that fires once you've been together for 2 minutes */
const togetherTimers = new Map<string, any>();

/** Call when you and userId are now in the same VC */
function startTogether(userId: string, channelId: string) {
    if (userId === UserStore.getCurrentUser()?.id || togetherTimers.has(userId)) return;
    togetherTimers.set(userId, setTimeout(() => {
        togetherTimers.delete(userId);
        // still together after 2 minutes?
        if (SelectedChannelStore.getVoiceChannelId() !== channelId) return;
        if (!VoiceStateStore.getVoiceStatesForChannel(channelId)?.[userId]) return;
        const prev = seen[userId];
        seen[userId] = { count: (prev?.count ?? 0) + 1, last: Date.now(), channel: ChannelStore.getChannel(channelId)?.name ?? "?" };
        seenDirty = true;
    }, MEET_MS));
}

function stopTogether(userId: string) {
    clearTimeout(togetherTimers.get(userId));
    togetherTimers.delete(userId);
}

function stopAllTogether() {
    togetherTimers.forEach(t => clearTimeout(t));
    togetherTimers.clear();
}

function seenText(userId: string) {
    return `Meets: ${seen[userId]?.count ?? 0}`;
}

let saveTimer: any;
function startSaving() {
    saveTimer = setInterval(() => {
        if (!seenDirty) return;
        seenDirty = false;
        DataStore.set(SEEN_KEY, seen).catch(e => logger.error("save failed", e));
    }, 10_000);
}

// ---------- join log (#4) ----------

interface LogEntry { userId: string; type: "join" | "leave"; time: number; channel: string; }
const joinLog: LogEntry[] = [];
const logListeners = new Set<() => void>();
function addLog(e: LogEntry) {
    joinLog.unshift(e);
    if (joinLog.length > 300) joinLog.pop();
    logListeners.forEach(f => f());
}

const LOG_PAGE_SIZE = 15;

function avatarUrl(userId: string) {
    const u = UserStore.getUser(userId) as any;
    if (u?.getAvatarURL) return u.getAvatarURL(undefined, 64, false);
    return `https://cdn.discordapp.com/embed/avatars/${Number((BigInt(userId) >> 22n) % 6n)}.png`;
}

function JoinLogModal({ modalProps }: { modalProps: RenderModalProps; }) {
    const [, force] = useState(0);
    const [page, setPage] = useState(0);
    useState(() => { const f = () => force(x => x + 1); logListeners.add(f); return () => logListeners.delete(f); });
    const tagger = Vencord.Plugins.plugins.VcTagger as any;

    const pages = Math.max(1, Math.ceil(joinLog.length / LOG_PAGE_SIZE));
    const cur = Math.min(page, pages - 1);
    const rows = joinLog.slice(cur * LOG_PAGE_SIZE, (cur + 1) * LOG_PAGE_SIZE);

    return (
        <Modal {...modalProps} title={`VC join log (${joinLog.length})`} size="md">
            {joinLog.length === 0
                ? <Text variant="text-md/normal">Nobody joined or left your VC yet in this session.</Text>
                : (
                    <>
                        <div className="vc-quickkick-log">
                            {rows.map((e, i) => {
                                const u = UserStore.getUser(e.userId);
                                const tag = tagger?.started ? tagger.getTag(e.userId) : null;
                                return (
                                    <div key={`${e.time}-${i}`} className="vc-quickkick-log-row">
                                        <img className="vc-quickkick-log-avatar" src={avatarUrl(e.userId)} alt="" loading="lazy" />
                                        <div className="vc-quickkick-log-body">
                                            <div className="vc-quickkick-log-line">
                                                <span className={e.type === "join" ? "vc-quickkick-in" : "vc-quickkick-out"}>{e.type === "join" ? "→ joined" : "← left"}</span>
                                                <span className="vc-quickkick-log-name">{displayName(u, e.userId)}</span>
                                                {tag && <span className="vc-vctagger-badge vc-vctagger-compact">⚠ {tag.label}</span>}
                                                <span className="vc-quickkick-log-time">{new Date(e.time).toLocaleTimeString()}</span>
                                            </div>
                                            <span className="vc-quickkick-log-meta">{e.channel} · {e.userId}</span>
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                        {pages > 1 && (
                            <div className="vc-quickkick-pager">
                                <button disabled={cur === 0} onClick={() => setPage(0)}>«</button>
                                <button disabled={cur === 0} onClick={() => setPage(cur - 1)}>‹ Prev</button>
                                <span>Page {cur + 1} / {pages}</span>
                                <button disabled={cur >= pages - 1} onClick={() => setPage(cur + 1)}>Next ›</button>
                                <button disabled={cur >= pages - 1} onClick={() => setPage(pages - 1)}>»</button>
                            </div>
                        )}
                    </>
                )}
        </Modal>
    );
}

// ---------- bulk kick / reject ----------

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
let bulkRunning = false;

async function runBulk(kind: "kick" | "reject", ids: string[]) {
    if (bulkRunning) return showToast("A bulk action is already running", "failure");
    bulkRunning = true;
    try {
        const per = Math.max(1, Math.floor(settings.store.bulkPerCommand));
        const template = getCommand(kind);
        for (let i = 0; i < ids.length; i += per) {
            const chunk = ids.slice(i, i + per);
            if (!sendCommand(template.replaceAll("{id}", chunk.join(" ")))) return;
            chunk.forEach(id => noteRemoved(kind, id, true));
            if (i + per < ids.length) await sleep(Math.max(0.5, settings.store.bulkDelay) * 1000);
        }
        showToast(`${PAST[kind]} ${ids.length} user${ids.length === 1 ? "" : "s"}`, "success");
    } finally {
        bulkRunning = false;
    }
}

async function runBulkPermit(ids: string[]) {
    if (bulkRunning) return showToast("A bulk action is already running", "failure");
    bulkRunning = true;
    try {
        // the bot only takes one ID per permit, so one command each
        for (let i = 0; i < ids.length; i++) {
            if (!permitId(ids[i])) return;
            if (i < ids.length - 1) await sleep(Math.max(0.5, settings.store.bulkDelay) * 1000);
        }
        showToast(`Permitted ${ids.length} user${ids.length === 1 ? "" : "s"}`, "success");
    } finally {
        bulkRunning = false;
    }
}

function BulkModal({ modalProps }: { modalProps: RenderModalProps; }) {
    const me = UserStore.getCurrentUser()?.id;
    const myChan = useStateFromStores([SelectedChannelStore], () => SelectedChannelStore.getVoiceChannelId());
    const inVcKey = useStateFromStores([VoiceStateStore], () => Object.keys((myChan && VoiceStateStore.getVoiceStatesForChannel(myChan)) ?? {}).filter(id => id !== me).join(","), [myChan]);
    const inVc = inVcKey ? inVcKey.split(",") : [];
    const recent = [...removed.keys()].reverse().filter(id => !inVc.includes(id));
    const [picked, setPicked] = useState<Set<string>>(new Set());
    const [extra, setExtra] = useState("");

    const extraIds = [...new Set(extra.match(/\d{15,21}/g) ?? [])].filter(id => id !== me);
    const ids = [...new Set([...inVc, ...recent].filter(id => picked.has(id)).concat(extraIds))];
    const flip = (id: string) => setPicked(p => { const n = new Set(p); n.has(id) ? n.delete(id) : n.add(id); return n; });
    const go = (kind: "kick" | "reject" | "permit") => {
        if (!ids.length) return;
        modalProps.onClose();
        kind === "permit" ? runBulkPermit(ids) : runBulk(kind, ids);
    };
    const row = (id: string, note?: string) => (
        <label key={id} className="vc-quickkick-bulk-row">
            <input type="checkbox" checked={picked.has(id)} onChange={() => flip(id)} />
            <img className="vc-quickkick-log-avatar" src={avatarUrl(id)} alt="" />
            <span className="vc-quickkick-log-name">{displayName(UserStore.getUser(id), id)}</span>
            <span className="vc-quickkick-log-meta">{note ?? id}</span>
        </label>
    );

    return (
        <Modal
            {...modalProps}
            title={`Bulk kick / reject / permit (${ids.length} selected)`}
            size="md"
            actions={[
                { text: `Reject ${ids.length}`, variant: "critical-primary", onClick: () => go("reject"), disabled: !ids.length },
                { text: `Kick ${ids.length}`, variant: "secondary", onClick: () => go("kick"), disabled: !ids.length },
                { text: `Permit ${ids.length}`, variant: "primary", onClick: () => go("permit"), disabled: !ids.length }
            ] as any}
        >
            <div className="vc-quickkick-bulk">
                <Text variant="text-sm/semibold">In your VC</Text>
                {inVc.length === 0
                    ? <Text variant="text-md/normal">Nobody else is in your VC.</Text>
                    : (
                        <>
                            <div className="vc-quickkick-bulk-tools">
                                <button onClick={() => setPicked(p => new Set([...p, ...inVc]))}>Select all</button>
                                <button onClick={() => setPicked(p => new Set([...p].filter(id => !inVc.includes(id))))}>Clear</button>
                            </div>
                            {inVc.map(id => row(id))}
                        </>
                    )}
                {recent.length > 0 && (
                    <>
                        <Text variant="text-sm/semibold" style={{ marginTop: 10 }}>Recently removed (for permit)</Text>
                        <div className="vc-quickkick-bulk-tools">
                            <button onClick={() => setPicked(p => new Set([...p, ...recent]))}>Select all</button>
                            <button onClick={() => setPicked(p => new Set([...p].filter(id => !recent.includes(id))))}>Clear</button>
                        </div>
                        {recent.map(id => {
                            const rm = removed.get(id)!;
                            return row(id, `${rm.kind === "kick" ? "kicked" : "rejected"} ${new Date(rm.time).toLocaleTimeString()}`);
                        })}
                    </>
                )}
                <Text variant="text-sm/normal" style={{ marginTop: 8 }}>Extra user IDs or @mentions (people not in the VC):</Text>
                <textarea className="vc-quickkick-bulk-extra" value={extra} onChange={e => setExtra(e.currentTarget.value)} placeholder={"123456789012345678\n<@987654321098765432>"} />
            </div>
        </Modal>
    );
}

// ---------- per-server command setup ----------

// ---------- voice bot detection via the server's slash command index ----------

interface BotInfo { id: string; name: string; commands: string[]; }
const VOICE_HINT = /voice|vc|reject|permit|lock|unlock|claim|kick|limit|channel|room|temp/i;
const botCache = new Map<string, BotInfo[]>();

async function fetchVoiceBots(guildId: string): Promise<BotInfo[]> {
    if (botCache.has(guildId)) return botCache.get(guildId)!;
    try {
        const { body } = await RestAPI.get({ url: `/guilds/${guildId}/application-command-index` });
        const apps = new Map<string, string>((body?.applications ?? []).map((a: any) => [a.id, a.name]));
        const byApp = new Map<string, string[]>();
        for (const c of body?.application_commands ?? []) {
            if (c.type && c.type !== 1) continue; // chat commands only
            const names: string[] = [];
            const subs = (c.options ?? []).filter((o: any) => o.type === 1 || o.type === 2);
            if (!subs.length) names.push(c.name);
            for (const o of subs) {
                if (o.type === 1) names.push(`${c.name} ${o.name}`);
                else for (const so of o.options ?? []) names.push(`${c.name} ${o.name} ${so.name}`);
            }
            byApp.set(c.application_id, [...(byApp.get(c.application_id) ?? []), ...names]);
        }
        const bots = [...byApp]
            .filter(([id, cmds]) => VOICE_HINT.test(apps.get(id) ?? "") || cmds.filter(n => VOICE_HINT.test(n)).length >= 2)
            .map(([id, cmds]) => ({ id, name: apps.get(id) ?? "Unknown bot", commands: cmds.filter(n => VOICE_HINT.test(n)).concat(cmds.filter(n => !VOICE_HINT.test(n))) }));
        botCache.set(guildId, bots);
        return bots;
    } catch (e) {
        logger.warn("couldn't load slash commands", e);
        return [];
    }
}

function ServerCommandsModal({ modalProps, guildId }: { modalProps: RenderModalProps; guildId: string; }) {
    const saved: ServerConfig = settings.store.serverCommands?.[guildId] ?? {};
    const [prefix, setPrefix] = useState(saved.prefix ?? "");
    const [cmds, setCmds] = useState<Record<string, string>>(saved.commands ?? {});
    const guildName = GuildStore.getGuild(guildId)?.name ?? "this server";
    const usedPrefix = prefix.trim() || saved.detected || settings.store.defaultPrefix || ".v";
    const [bots, setBots] = useState<BotInfo[] | null>(null);
    useEffect(() => { fetchVoiceBots(guildId).then(setBots); }, [guildId]);
    const detectedBotName = saved.detectedBot && displayName(UserStore.getUser(saved.detectedBot), "a bot");

    const save = () => {
        try {
            const commands = Object.fromEntries(Object.entries(cmds).map(([k, v]) => [k, inputText(v).trim()]).filter(([, v]) => v));
            const all: Record<string, ServerConfig> = plain(settings.store.serverCommands);
            const cleanPrefix = inputText(prefix).trim();
            const next: ServerConfig = { ...all[guildId], prefix: cleanPrefix || undefined, commands };
            if (!next.prefix && !Object.keys(commands).length && !next.detected) delete all[guildId];
            else all[guildId] = next;
            settings.store.serverCommands = all;
            showToast(`Saved commands for ${guildName}`, "success");
        } catch (e) {
            logger.error("saving server commands failed", e);
            showToast("Couldn't save, see console (Ctrl+Shift+I)", "failure");
        }
        modalProps.onClose();
    };

    return (
        <Modal {...modalProps} title={`Bot commands · ${guildName}`} size="md" actions={[{ text: "Save", variant: "primary", onClick: save }]}>
            <div className="vc-quickkick-srv">
                <div className="vc-quickkick-srv-detect">
                    {saved.detected
                        ? <>🔍 Auto-detected prefix: <b>{saved.detected}</b>{detectedBotName ? <> (answered by <b>{detectedBotName}</b>)</> : null}</>
                        : <>🔍 No prefix detected yet. Use any VC command once (e.g. <b>!v lock</b>) in this server and it will be learned when the bot replies.</>}
                </div>
                {bots === null
                    ? <Text variant="text-xs/normal">Looking for voice bots…</Text>
                    : bots.length > 0 && (
                        <div className="vc-quickkick-srv-bots">
                            {bots.map(b => (
                                <div key={b.id}>
                                    <b>{b.name}</b> slash commands: {b.commands.slice(0, 25).map(c => <code key={c}>/{c}</code>)}{b.commands.length > 25 && " …"}
                                </div>
                            ))}
                        </div>
                    )}
                <Text variant="text-sm/normal" style={{ marginTop: 6 }}>Prefix override (empty = {saved.detected ? "detected" : "default"} <b>{saved.detected || settings.store.defaultPrefix || ".v"}</b>), e.g. <b>!v</b>, <b>-v</b>, <b>.vc</b></Text>
                <TextInput value={prefix} onChange={v => setPrefix(inputText(v))} placeholder={saved.detected || settings.store.defaultPrefix || ".v"} />
                <Text variant="text-sm/normal" style={{ marginTop: 10 }}>Only fill these if this server's bot uses different words. Empty = default shown in grey. Use <b>{"{id}"}</b> for the user ID, <b>{"{text}"}</b> for name/limit.</Text>
                {COMMAND_KEYS.map(({ key, label }) => (
                    <div key={key} className="vc-quickkick-srv-row">
                        <span>{label}</span>
                        <TextInput
                            value={cmds[key] ?? ""}
                            onChange={v => setCmds(c => ({ ...c, [key]: inputText(v) }))}
                            placeholder={(settings.store[`${key}Command`] as string).replace(/^(\{p\}|\.v)(?=\s|$)/, usedPrefix)}
                        />
                    </div>
                ))}
            </div>
        </Modal>
    );
}

function openServerCommands() {
    const guildId = currentGuildId();
    if (!guildId) return showToast("Join a voice channel in the server first", "failure");
    openModal(p => <ErrorBoundary><ServerCommandsModal modalProps={p} guildId={guildId} /></ErrorBoundary>);
}

// ---------- prompt modal for rename / limit ----------

function PromptModal({ modalProps, title, placeholder, onSubmit }: { modalProps: RenderModalProps; title: string; placeholder: string; onSubmit(v: string): void; }) {
    const [value, setValue] = useState("");
    const submit = () => {
        const v = inputText(value).trim();
        if (!v) return showToast("Type something first", "failure");
        onSubmit(v);
        modalProps.onClose();
    };
    return (
        <Modal {...modalProps} title={title} actions={[{ text: "Send", variant: "primary", onClick: submit }]}>
            <div style={{ padding: "8px 0" }} onKeyDown={e => e.key === "Enter" && submit()}>
                <TextInput value={value} onChange={v => setValue(inputText(v))} placeholder={placeholder} autoFocus />
            </div>
        </Modal>
    );
}

const prompt = (title: string, placeholder: string, onSubmit: (v: string) => void) =>
    openModal(p => <ErrorBoundary><PromptModal modalProps={p} title={title} placeholder={placeholder} onSubmit={onSubmit} /></ErrorBoundary>);

// ---------- ✕ button next to voice users (#2) ----------

// ---------- real server mute / deafen (only works if Discord gives you the permission, e.g. as VC owner) ----------

function canVoiceMod(bit: bigint) {
    const chan = ChannelStore.getChannel(SelectedChannelStore.getVoiceChannelId()!);
    return !!chan && PermissionStore.can(bit, chan);
}

async function setVoiceFlag(user: User, flag: "mute" | "deaf", value: boolean) {
    const chan = ChannelStore.getChannel(SelectedChannelStore.getVoiceChannelId()!);
    if (!chan?.guild_id) return;
    try {
        await RestAPI.patch({ url: `/guilds/${chan.guild_id}/members/${user.id}`, body: { [flag]: value } });
        showToast(`${value ? "Force " : "Un-"}${flag === "mute" ? "muted" : "deafened"} ${displayName(user)}`, "success");
    } catch (e: any) {
        showToast(`Discord refused: ${e?.body?.message ?? e?.status ?? "no permission"}`, "failure");
    }
}

function openUserMenu(e: React.MouseEvent, user: User) {
    const voice = VoiceStateStore.getVoiceStateForUser(user.id) as any;
    const canMute = canVoiceMod(PermissionsBits.MUTE_MEMBERS);
    const canDeaf = canVoiceMod(PermissionsBits.DEAFEN_MEMBERS);
    ContextMenuApi.openContextMenu(e as any, () => (
        <Menu.Menu navId="vc-quickkick-user" onClose={ContextMenuApi.closeContextMenu} aria-label="VC actions">
            <Menu.MenuGroup label={displayName(user)}>
                {USER_ACTIONS.map(a => (
                    <Menu.MenuItem key={a.id} id={`vc-quickkick-${a.id}`} label={a.label} color={a.danger ? "danger" : undefined} action={() => runUserAction(a.id, user)} />
                ))}
            </Menu.MenuGroup>
            <Menu.MenuGroup label={canMute || canDeaf ? "Voice (everyone)" : "Voice — you don't have permission in this VC"}>
                <Menu.MenuItem
                    id="vc-quickkick-forcemute"
                    label={voice?.mute ? "Force unmute" : "Force mute"}
                    color="danger"
                    disabled={!canMute}
                    action={() => setVoiceFlag(user, "mute", !voice?.mute)}
                />
                <Menu.MenuItem
                    id="vc-quickkick-forcedeaf"
                    label={voice?.deaf ? "Force undeafen" : "Force deafen"}
                    color="danger"
                    disabled={!canDeaf}
                    action={() => setVoiceFlag(user, "deaf", !voice?.deaf)}
                />
            </Menu.MenuGroup>
        </Menu.Menu>
    ));
}

function KickButton({ user }: { user: User; }) {
    const myChan = useStateFromStores([SelectedChannelStore], () => SelectedChannelStore.getVoiceChannelId());
    const inMyVc = useStateFromStores([VoiceStateStore], () => !!myChan && !!VoiceStateStore.getVoiceStatesForChannel(myChan)?.[user.id], [myChan, user.id]);
    const { action } = settings.use(["action"]);

    if (!inMyVc || user.id === UserStore.getCurrentUser()?.id) return null;

    const label = action === "kick" ? "Kick" : "Reject";
    return (
        <Tooltip text={seenText(user.id)}>
            {props => (
                <span
                    {...props}
                    className="vc-quickkick-btn"
                    role="button"
                    onMouseDown={e => e.stopPropagation()}
                    onClick={e => { e.preventDefault(); e.stopPropagation(); runUserAction(action as UserAction, user); }}
                    onContextMenu={e => { e.preventDefault(); e.stopPropagation(); openUserMenu(e, user); }}
                >
                    ✕
                </span>
            )}
        </Tooltip>
    );
}

// ---------- ✕ button on the big call cards ----------

const TILE_SEL = "[data-selenium-video-tile]";

/** find the user id behind a call card: data attribute first, then React props */
function tileUserId(tile: HTMLElement): string | null {
    const fromAttr = tile.getAttribute("data-selenium-video-tile")?.match(/\d{15,21}/)?.[0];
    if (fromAttr) return fromAttr;
    const key = Object.keys(tile).find(k => k.startsWith("__reactFiber$"));
    let fiber = key ? (tile as any)[key] : null;
    for (let i = 0; fiber && i < 15; i++, fiber = fiber.return) {
        const p = fiber.memoizedProps;
        const id = p?.participantUserId ?? p?.participant?.user?.id ?? p?.userId ?? p?.user?.id;
        if (typeof id === "string" && /^\d{15,21}$/.test(id)) return id;
    }
    return null;
}

function decorateTiles() {
    const myChan = SelectedChannelStore.getVoiceChannelId();
    const me = UserStore.getCurrentUser()?.id;
    const inVc = (myChan && VoiceStateStore.getVoiceStatesForChannel(myChan)) || {};

    document.querySelectorAll<HTMLElement>(TILE_SEL).forEach(tile => {
        const old = tile.querySelector<HTMLElement>(":scope > .vc-quickkick-tile-btn");
        const id = settings.store.tileButton ? tileUserId(tile) : null;
        const show = !!id && id !== me && !!inVc[id];

        if (!show) return void old?.remove();
        if (old?.dataset.uid === id) return;
        old?.remove();

        const btn = document.createElement("span");
        btn.className = "vc-quickkick-tile-btn";
        btn.dataset.uid = id!;
        btn.textContent = "✕";
        btn.title = `${settings.store.action === "kick" ? "Kick" : "Reject"} · right-click for more · ${seenText(id!)}`;
        const stop = (e: Event) => { e.preventDefault(); e.stopPropagation(); };
        btn.addEventListener("mousedown", e => e.stopPropagation());
        btn.addEventListener("dblclick", stop);
        btn.addEventListener("click", e => {
            stop(e);
            const user = UserStore.getUser(id!);
            if (user) runUserAction(settings.store.action as UserAction, user);
        });
        btn.addEventListener("contextmenu", e => {
            stop(e);
            const user = UserStore.getUser(id!);
            if (user) openUserMenu(e as any, user);
        });
        tile.appendChild(btn);
    });
}

let tileObserver: MutationObserver | null = null;
let tileQueued = false;
function queueDecorate() {
    if (tileQueued) return;
    tileQueued = true;
    requestAnimationFrame(() => { tileQueued = false; decorateTiles(); });
}

function startTiles() {
    tileObserver = new MutationObserver(queueDecorate);
    tileObserver.observe(document.body, { childList: true, subtree: true });
    queueDecorate();
}

function stopTiles() {
    tileObserver?.disconnect();
    tileObserver = null;
    document.querySelectorAll(".vc-quickkick-tile-btn").forEach(b => b.remove());
}

// ---------- VC control panel in the chat bar (#3) ----------

function ShieldIcon({ height = 20, width = 20, className }: IconProps) {
    return (
        <svg width={width} height={height} viewBox="0 0 24 24" className={className}>
            <path fill="currentColor" d="M12 2 4 5v6c0 5 3.4 9.7 8 11 4.6-1.3 8-6 8-11V5l-8-3Zm0 5a2.5 2.5 0 0 1 1 4.8V15h-2v-3.2A2.5 2.5 0 0 1 12 7Z" />
        </svg>
    );
}

function openPanel(e: React.MouseEvent) {
    const item = (id: string, label: string, action: () => void) => <Menu.MenuItem id={`vc-quickkick-p-${id}`} label={label} action={action} />;
    ContextMenuApi.openContextMenu(e as any, () => (
        <Menu.Menu navId="vc-quickkick-panel" onClose={ContextMenuApi.closeContextMenu} aria-label="VC control panel">
            <Menu.MenuGroup label="Voice channel">
                {item("lock", "🔒 Lock", () => runChannelAction("lock"))}
                {item("unlock", "🔓 Unlock", () => runChannelAction("unlock"))}
                {item("hide", "🙈 Hide", () => runChannelAction("hide"))}
                {item("unhide", "👁 Unhide", () => runChannelAction("unhide"))}
                {item("claim", "👑 Claim", () => runChannelAction("claim"))}
            </Menu.MenuGroup>
            <Menu.MenuGroup>
                {item("name", "✏️ Rename…", () => prompt("Rename VC", "GIRLS ONLY", v => runChannelAction("name", v)))}
                {item("limit", "👥 User limit…", () => prompt("User limit", "e.g. 5 (0 = no limit)", v => runChannelAction("limit", v)))}
            </Menu.MenuGroup>
            <Menu.MenuGroup>
                {item("bulk", "🧹 Bulk kick / reject / permit…", () => openModal(p => <ErrorBoundary><BulkModal modalProps={p} /></ErrorBoundary>))}
                {item("cowner", "👑 Add co-owner…", () => prompt("Add co-owner", "User ID or @mention", v => {
                    const id = v.match(/\d{15,21}/)?.[0];
                    if (!id) return showToast("That's not a user ID", "failure");
                    runUserAction("cowner", UserStore.getUser(id) ?? ({ id, username: id } as any as User));
                }))}
            </Menu.MenuGroup>
            <Menu.MenuGroup>
                {item("permit", "✅ Permit user ID…", () => prompt("Permit user", "User ID or @mention", v => {
                    const id = v.match(/\d{15,21}/)?.[0];
                    id ? permitId(id) : showToast("That's not a user ID", "failure");
                }))}
                {removed.size > 0 && (
                    <Menu.MenuItem id="vc-quickkick-p-recent" label="✅ Permit recently removed">
                        {[...removed].reverse().map(([id, r]) => (
                            <Menu.MenuItem
                                key={id}
                                id={`vc-quickkick-p-recent-${id}`}
                                label={`${displayName(UserStore.getUser(id), id)} (${r.kind === "kick" ? "kicked" : "rejected"} ${new Date(r.time).toLocaleTimeString()})`}
                                action={() => permitId(id)}
                            />
                        ))}
                    </Menu.MenuItem>
                )}
            </Menu.MenuGroup>
            <Menu.MenuGroup>
                {item("servercmds", "⚙️ Server commands…", openServerCommands)}
                {item("log", "📜 Join log", () => openModal(p => <ErrorBoundary><JoinLogModal modalProps={p} /></ErrorBoundary>))}
            </Menu.MenuGroup>
        </Menu.Menu>
    ));
}

const PanelButton: ChatBarButtonFactory = ({ channel }) => {
    const myChan = useStateFromStores([SelectedChannelStore], () => SelectedChannelStore.getVoiceChannelId());
    if (!channel || channel.id !== myChan) return null;
    return (
        <ChatBarButton tooltip="VC controls" onClick={openPanel} onContextMenu={openPanel}>
            <ShieldIcon />
        </ChatBarButton>
    );
};

// ---------- auto-reject (#1) + log + seen, from voice events ----------

const autoRejectCooldown = new Map<string, number>();

async function maybeAutoReject(userId: string, channelId: string) {
    if (!settings.store.autoReject) return;
    const tagger = Vencord.Plugins.plugins.VcTagger as any;
    if (!tagger?.started) return;
    if (settings.store.autoRejectOnlyWhenOwner && !iOwnThisVc(channelId)) return;
    if ((autoRejectCooldown.get(userId) ?? 0) > Date.now()) return;

    const tag = await tagger.getTagAsync(userId);
    if (!tag) return;
    // you permitted them after they were tagged -> let them in; tagged again after the permit -> reject
    const permittedAt = permitted.get(userId);
    if (permittedAt && (tag.date ?? 0) < permittedAt) return;
    // still in my VC?
    if (SelectedChannelStore.getVoiceChannelId() !== channelId) return;
    if (!VoiceStateStore.getVoiceStatesForChannel(channelId)?.[userId]) return;

    autoRejectCooldown.set(userId, Date.now() + 20_000);
    const user = UserStore.getUser(userId);
    if (user) runUserAction("reject", user, true);
}

/** Best guess: I own the VC if I was the first in it (no one else there when I joined) */
let ownedChannel: string | null = null;
function iOwnThisVc(channelId: string) {
    return ownedChannel === channelId;
}

// right-click any user (side chat, mentions, member list) -> permit / kick / reject
const userContextPatch: NavContextMenuPatchCallback = (children, { user }: { user?: User; }) => {
    if (!user || user.id === UserStore.getCurrentUser()?.id || !SelectedChannelStore.getVoiceChannelId()) return;
    children.push(
        <Menu.MenuGroup>
            <Menu.MenuItem id="vc-quickkick-ctx" label="VC actions">
                {USER_ACTIONS.map(a => (
                    <Menu.MenuItem key={a.id} id={`vc-quickkick-ctx-${a.id}`} label={a.label} color={a.danger ? "danger" : undefined} action={() => runUserAction(a.id, user)} />
                ))}
            </Menu.MenuItem>
        </Menu.MenuGroup>
    );
};

export default definePlugin({
    name: "VcQuickKick",
    description: "One-click kick/reject in your VC, auto-reject tagged users, VC control panel, join log & 'seen before' history",
    authors: [{ name: "you", id: 0n }],
    settings,

    patches: [
        {
            find: "#{intl::GUEST_NAME_SUFFIX})]",
            replacement: {
                match: /(?=\i\?\?\i\.\i\.getName\((\i)\),.{0,80}?#{intl::GUEST_NAME_SUFFIX})/,
                replace: "$self.renderKickButton($1),"
            }
        }
    ],

    contextMenus: {
        "user-context": userContextPatch
    },

    toolboxActions: {
        "VC join log": () => openModal(p => <ErrorBoundary><JoinLogModal modalProps={p} /></ErrorBoundary>)
    },

    chatBarButton: {
        icon: ShieldIcon,
        render: PanelButton
    },

    renderKickButton(user: User) {
        if (!user?.id) return null;
        return (
            <ErrorBoundary noop key="vc-quickkick">
                <KickButton user={user} />
            </ErrorBoundary>
        );
    },

    async start() {
        startTiles();
        FluxDispatcher.subscribe("MESSAGE_CREATE", onMessageCreate);
        seen = (await DataStore.get<Record<string, Seen>>(SEEN_KEY)) ?? {};
        startSaving();

        // count people already with me (e.g. after a reload)
        const chan = SelectedChannelStore.getVoiceChannelId();
        if (chan) Object.keys(VoiceStateStore.getVoiceStatesForChannel(chan) ?? {}).forEach(id => startTogether(id, chan));
    },

    stop() {
        stopTiles();
        FluxDispatcher.unsubscribe("MESSAGE_CREATE", onMessageCreate);
        clearInterval(saveTimer);
        stopAllTogether();
        if (seenDirty) DataStore.set(SEEN_KEY, seen);
        pendingDeletes.clear();
        candidates.clear();
        removed.clear();
        permitted.clear();
    },

    flux: {
        VOICE_STATE_UPDATES({ voiceStates }: { voiceStates: { userId: string; channelId?: string; oldChannelId?: string; }[]; }) {
            const myChan = SelectedChannelStore.getVoiceChannelId();
            const me = UserStore.getCurrentUser()?.id;
            if (!me) return;
            queueDecorate();

            for (const { userId, channelId, oldChannelId } of voiceStates) {
                try {
                    if (userId === me) {
                        if (channelId && channelId !== oldChannelId) {
                            stopAllTogether();
                            const others = Object.keys(VoiceStateStore.getVoiceStatesForChannel(channelId) ?? {}).filter(id => id !== me);
                            ownedChannel = others.length === 0 ? channelId : null;
                            others.forEach(id => {
                                startTogether(id, channelId);
                                maybeAutoReject(id, channelId);
                            });
                        }
                        continue;
                    }
                    if (!myChan) continue;

                    const chanName = ChannelStore.getChannel(myChan)?.name ?? "?";
                    if (channelId === myChan && oldChannelId !== myChan) {
                        addLog({ userId, type: "join", time: Date.now(), channel: chanName });
                        startTogether(userId, myChan);
                        maybeAutoReject(userId, myChan);
                    } else if (oldChannelId === myChan && channelId !== myChan) {
                        addLog({ userId, type: "leave", time: Date.now(), channel: chanName });
                        stopTogether(userId);
                    }
                } catch (e) {
                    logger.error("voice update failed", e);
                }
            }
        }
    }
});
