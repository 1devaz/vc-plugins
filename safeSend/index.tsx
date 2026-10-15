/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./style.css";

import { ChatBarButton, ChatBarButtonFactory } from "@api/ChatButtons";
import { definePluginSettings } from "@api/Settings";
import { sendMessage } from "@utils/discord";
import { Logger } from "@utils/Logger";
import definePlugin, { IconProps, OptionType } from "@utils/types";
import {
    ChannelStore, FluxDispatcher, MessageActions, PermissionsBits, PermissionStore, Popout, RestAPI,
    SelectedChannelStore, showToast, UserStore, useRef, useState
} from "@webpack/common";

import { confirmDialog } from "./ui";

const logger = new Logger("SafeSend");

const TIMERS: { value: number; label: string; }[] = [
    { value: 0, label: "Off" },
    { value: 10, label: "10 seconds" },
    { value: 60, label: "1 minute" },
    { value: 300, label: "5 minutes" },
    { value: 3600, label: "1 hour" }
];

const settings = definePluginSettings({
    timer: {
        type: OptionType.SELECT,
        description: "Self-destruct: delete your messages this long after you send them",
        options: TIMERS.map(t => ({ label: t.label, value: t.value, default: t.value === 0 }))
    },
    warnOnEdit: {
        type: OptionType.BOOLEAN,
        description: "Warn before editing a message (edits are kept by message loggers) and offer delete + resend instead",
        default: true
    }
});

const timerLabel = (s: number) => (s === 0 ? "" : s < 60 ? `${s}s` : s < 3600 ? `${s / 60}m` : `${s / 3600}h`);

// ---------- self-destruct ----------

const pending = new Map<string, ReturnType<typeof setTimeout>>(); // messageId -> timer

function onMessageCreate({ message, optimistic }: { message: any; optimistic?: boolean; }) {
    const seconds = settings.store.timer;
    if (!seconds || optimistic || !message?.id) return;
    if (message.author?.id !== UserStore.getCurrentUser()?.id) return;
    if (pending.has(message.id)) return;

    pending.set(message.id, setTimeout(() => {
        pending.delete(message.id);
        MessageActions.deleteMessage(message.channel_id, message.id);
    }, seconds * 1000));
}

function clearPending() {
    pending.forEach(t => clearTimeout(t));
    pending.clear();
}

// ---------- delete all my messages in a channel ----------

let deleting: string | null = null; // channel being cleaned
let stopRequested = false;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/** Discord search finds only YOUR messages directly, so we don't have to scroll the whole history */
async function searchMine(channelId: string, me: string) {
    const guildId = ChannelStore.getChannel(channelId)?.guild_id;
    const url = guildId ? `/guilds/${guildId}/messages/search` : `/channels/${channelId}/messages/search`;
    for (let tries = 0; tries < 5; tries++) {
        const res: any = await RestAPI.get({ url, query: { author_id: me, ...(guildId ? { channel_id: channelId } : {}), include_nsfw: true } } as any);
        if (res.status !== 202) return { total: res.body?.total_results ?? 0, messages: (res.body?.messages ?? []).map((g: any[]) => g[0]) as any[] };
        await sleep((res.body?.retry_after ?? 2) * 1000); // still indexing
    }
    throw new Error("search index not ready");
}

const HISTORY_PAGES = 50; // read the newest 5000 messages directly; search covers anything older
const HISTORY_PAGES_EVERYONE = 300; // "everyone" mode has no search shortcut, so read further back

/** Discord only lets you delete other people's messages with Manage Messages in that channel */
function canDeleteOthers(channelId: string) {
    const ch = ChannelStore.getChannel(channelId);
    return !!ch?.guild_id && PermissionStore.can(PermissionsBits.MANAGE_MESSAGES, ch);
}

async function deleteAllMine(channelId: string, everyone = false) {
    const me = UserStore.getCurrentUser()?.id;
    if (!me) return;
    deleting = channelId;
    stopRequested = false;
    let done = 0;
    const tried = new Set<string>();

    const del = async (id: string) => {
        if (tried.has(id) || stopRequested) return;
        tried.add(id); // never retry one that failed (e.g. system messages)
        try {
            await MessageActions.deleteMessage(channelId, id);
            done++;
            if (done % 10 === 0) showToast(`Deleted ${done}…`, "message");
        } catch (e) {
            logger.warn("couldn't delete", id, e);
        }
        await sleep(1100); // stay under Discord's delete rate limit
    };

    try {
        // 1) walk the channel history directly: always includes brand-new messages and VC chats,
        //    which Discord search hasn't indexed (or doesn't index at all)
        let before: string | undefined;
        let reachedStart = false;
        for (let page = 0; page < (everyone ? HISTORY_PAGES_EVERYONE : HISTORY_PAGES) && !stopRequested; page++) {
            const { body } = await RestAPI.get({ url: `/channels/${channelId}/messages`, query: { limit: 100, ...(before ? { before } : {}) } } as any);
            if (!body?.length) { reachedStart = true; break; }
            before = body[body.length - 1].id;
            for (const m of body) if (everyone || m.author?.id === me) await del(m.id);
            if (body.length < 100) { reachedStart = true; break; }
        }

        // 2) older than that: use search (finds only yours, no need to read everything)
        if (!reachedStart && !everyone) {
            try {
                while (!stopRequested) {
                    const { messages } = await searchMine(channelId, me);
                    const batch = messages.filter(m => m.author?.id === me && m.channel_id === channelId && !tried.has(m.id));
                    if (!batch.length) break;
                    for (const m of batch) await del(m.id);
                    await sleep(1500); // let search catch up before the next page
                }
            } catch (e) {
                logger.warn("search unavailable for this channel, older messages skipped", e);
                showToast("Older messages couldn't be searched here: only the newest 5000 were checked", "failure");
            }
        }
        showToast(`${stopRequested ? "Stopped. " : "Done. "}Deleted ${done} ${everyone ? "" : "of your "}message${done === 1 ? "" : "s"}`, "success");
    } catch (e) {
        logger.error("delete all failed", e);
        showToast(`Stopped after ${done}: Discord refused or rate-limited, try again later`, "failure");
    } finally {
        deleting = null;
    }
}

function confirmDeleteEveryone(channelId: string) {
    const ch = ChannelStore.getChannel(channelId) as any;
    const where = ch?.name ? `#${ch.name}` : "this chat";
    if (!canDeleteOthers(channelId)) return showToast("You don't have Manage Messages here, Discord won't allow it", "failure");
    confirmDialog({
        title: `Delete EVERY message in ${where}?`,
        body: `All messages from everyone in ${where} will be deleted, about 1 per second in the background. This can't be undone.`,
        confirmText: "Delete everything",
        danger: true,
        onConfirm: () => { showToast(`Deleting all messages in ${where}…`, "message"); deleteAllMine(channelId, true); }
    });
}

function confirmDeleteAll(channelId: string) {
    const ch = ChannelStore.getChannel(channelId) as any;
    const where = ch?.name ? `#${ch.name}` : "this DM";
    confirmDialog({
        title: "Delete ALL your messages?",
        body: `Every message you ever sent in ${where} will be deleted (about 1 per second, keeps going in the background). Other people's messages are not touched. This can't be undone.`,
        confirmText: "Delete all",
        danger: true,
        onConfirm: () => { showToast(`Deleting all your messages in ${where}…`, "message"); deleteAllMine(channelId); }
    });
}

// ---------- edit warning ----------

function confirmEdit(channelId: string, messageId: string, content: string): Promise<boolean> {
    // resolves true = cancel the edit
    return new Promise(resolve => {
        confirmDialog({
            title: "Edits are logged",
            body: "People using a message logger keep the original text and every edit. Delete the message and send the new text as a fresh one instead?",
            confirmText: "Delete + resend",
            cancelText: "Edit anyway",
            onConfirm: () => {
                MessageActions.deleteMessage(channelId, messageId);
                sendMessage(channelId, { content });
                resolve(true);
            },
            onCancel: () => resolve(false)
        });
    });
}

// ---------- chat bar button ----------

function LockIcon({ height = 24, width = 24, className }: IconProps) {
    // speech bubble with a padlock inside
    return (
        <svg width={width} height={height} viewBox="0 0 24 24" fill="none"
            stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round"
            className={(className ? className + " " : "") + "vc-safesend-icon"}>
            <path className="vc-safesend-bubble" d="M21 10.9a8.4 8.4 0 0 1-9 8.4 8.7 8.7 0 0 1-3.7-.9L3 20l1.7-5.3A8.4 8.4 0 0 1 4 11a8.4 8.4 0 0 1 8.4-8.4h.4A8.4 8.4 0 0 1 21 10.6v.3Z" />
            <g className="vc-safesend-lock">
                <rect x="8.3" y="10.8" width="7.4" height="5.6" rx="1.2" />
                <path d="M9.9 10.8V9a2.1 2.1 0 0 1 4.2 0v1.8" />
            </g>
        </svg>
    );
}

const SS_ICONS: Record<string, string[]> = {
    off: ["M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z", "M5.6 5.6l12.8 12.8"],
    timer: ["M12 21a8 8 0 1 0 0-16 8 8 0 0 0 0 16z", "M12 9v4l2.5 1.5", "M9 2h6"],
    trash: ["M3 6h18", "M8 6V4h8v2", "M6 6l1 14h10l1-14", "M10 11v5M14 11v5"],
    bomb: ["M11 22a7 7 0 1 0 0-14 7 7 0 0 0 0 14z", "M15 9l2.5-2.5", "M19 3l1 1M21 7h-1M17 2v1"],
    stop: ["M6 6h12v12H6z"]
};

function SsIcon({ name }: { name: string; }) {
    return (
        <svg viewBox="0 0 24 24" width={20} height={20} fill="none" stroke="currentColor"
            strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
            {SS_ICONS[name].map((d, i) => <path key={i} d={d} />)}
        </svg>
    );
}

function SafeSendPanel({ channelId, close }: { channelId: string; close: () => void; }) {
    const { timer } = settings.use(["timer"]);
    const [, force] = useState(0);
    const setTimer = (t: { value: number; label: string; }) => {
        settings.store.timer = t.value;
        showToast(t.value ? `Self-destruct on: ${t.label}` : "Self-destruct off", "success");
    };
    const short = (v: number) => (v === 0 ? "Off" : timerLabel(v));

    return (
        <div className="vc-ss-popout" role="menu">
            <div className="vc-ss-title">Self-destruct my messages</div>
            <div className="vc-ss-timers">
                {TIMERS.map(t => (
                    <button key={t.value} className={"vc-ss-tool" + (timer === t.value ? " vc-ss-active" : "")} onClick={() => setTimer(t)}>
                        <SsIcon name={t.value ? "timer" : "off"} />
                        <span>{short(t.value)}</span>
                    </button>
                ))}
            </div>
            <div className="vc-ss-sep" />
            <div className="vc-ss-grid">
                {deleting
                    ? <button className="vc-ss-tool vc-ss-danger" onClick={() => { stopRequested = true; force(x => x + 1); }}>
                        <SsIcon name="stop" /><span>Stop deleting</span>
                    </button>
                    : <>
                        <button className="vc-ss-tool vc-ss-danger" onClick={() => { close(); confirmDeleteAll(channelId); }}>
                            <SsIcon name="trash" /><span>Delete my messages</span>
                        </button>
                        {canDeleteOthers(channelId) && (
                            <button className="vc-ss-tool vc-ss-danger" onClick={() => { close(); confirmDeleteEveryone(channelId); }}>
                                <SsIcon name="bomb" /><span>Delete ALL messages</span>
                            </button>
                        )}
                    </>}
            </div>
        </div>
    );
}

const SafeSendButton: ChatBarButtonFactory = ({ channel }) => {
    const { timer } = settings.use(["timer"]);
    const buttonRef = useRef(null);
    const [show, setShow] = useState(false);
    if (!channel) return null;
    return (
        <Popout
            position="top"
            align="right"
            animation={Popout.Animation.SCALE}
            spacing={8}
            shouldShow={show}
            onRequestClose={() => setShow(false)}
            targetElementRef={buttonRef}
            renderPopout={({ closePopout }) => <SafeSendPanel channelId={channel.id} close={closePopout} />}
        >
            {() => (
                <ChatBarButton tooltip={timer ? `SafeSend: self-destruct ${TIMERS.find(t => t.value === timer)?.label}` : "SafeSend"} onClick={() => setShow(v => !v)}>
                    <span ref={buttonRef} className={`vc-safesend-btn${timer ? " vc-safesend-on" : ""}`}>
                        <LockIcon />
                        {timer ? <span className="vc-safesend-badge">{timerLabel(timer)}</span> : null}
                    </span>
                </ChatBarButton>
            )}
        </Popout>
    );
};

export default definePlugin({
    name: "SafeSend",
    description: "Protect your own messages: self-destruct timer, warn before edits, delete all your messages in a channel",
    authors: [{ name: "you", id: 0n }],
    settings,

    chatBarButton: {
        icon: LockIcon,
        render: SafeSendButton
    },

    async onBeforeMessageEdit(channelId: string, messageId: string, msg: { content: string; }) {
        if (!settings.store.warnOnEdit || !msg.content?.trim()) return;
        if (await confirmEdit(channelId, messageId, msg.content)) return { cancel: true };
    },

    start() {
        FluxDispatcher.subscribe("MESSAGE_CREATE", onMessageCreate);
    },

    stop() {
        FluxDispatcher.unsubscribe("MESSAGE_CREATE", onMessageCreate);
        clearPending();
        stopRequested = true;
    }
});
