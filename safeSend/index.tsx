/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./style.css";

import { ChatBarButton, ChatBarButtonFactory } from "@api/ChatButtons";
import * as DataStore from "@api/DataStore";
import { definePluginSettings } from "@api/Settings";
import ErrorBoundary from "@components/ErrorBoundary";
import { sendMessage } from "@utils/discord";
import { Logger } from "@utils/Logger";
import definePlugin, { IconProps, OptionType } from "@utils/types";
import type { RenderModalProps } from "@vencord/discord-types";
import {
    ChannelStore, FluxDispatcher, MessageActions, openModal, PermissionsBits, PermissionStore, Popout, RestAPI,
    useEffect, UserStore, useRef, useState
} from "@webpack/common";

import { confirmDialog, Modal, toast } from "./ui";

const logger = new Logger("SafeSend");
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

const TIMERS: { value: number; label: string; }[] = [
    { value: 0, label: "Off" },
    { value: 10, label: "10 seconds" },
    { value: 60, label: "1 minute" },
    { value: 300, label: "5 minutes" },
    { value: 3600, label: "1 hour" },
    { value: 86_400, label: "24 hours" }
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

const timerLabel = (s: number) => (s === 0 ? "Off" : s < 60 ? `${s}s` : s < 3600 ? `${s / 60}m` : `${s / 3600}h`);

// tiny subscribe/notify so the popout and the chat-bar button follow background work live
const listeners = new Set<() => void>();
const emit = () => listeners.forEach(f => f());
function useLive() {
    const [, force] = useState(0);
    useEffect(() => {
        const f = () => force(x => x + 1);
        listeners.add(f);
        return () => void listeners.delete(f);
    }, []);
}

// ---------- self-destruct ----------

// Saved to disk: a message sent with a timer is still deleted if Discord was closed or reloaded before the timer ran out
interface Pending { channelId: string; at: number; }
const PENDING_KEY = "SafeSend_pending";
let pending: Record<string, Pending> = {};
const timers = new Map<string, ReturnType<typeof setTimeout>>();

const savePending = () => DataStore.set(PENDING_KEY, pending).catch(e => logger.error("couldn't save pending deletes", e));

function schedule(messageId: string, delay: number) {
    if (timers.has(messageId)) return;
    timers.set(messageId, setTimeout(async () => {
        timers.delete(messageId);
        const p = pending[messageId];
        if (!p) return;
        try {
            await MessageActions.deleteMessage(p.channelId, messageId);
        } catch (e) {
            logger.warn("self-destruct failed (already deleted?)", messageId, e);
        }
        delete pending[messageId];
        savePending();
        emit();
    }, Math.max(0, delay)));
}

function onMessageCreate({ message, optimistic }: { message: any; optimistic?: boolean; }) {
    const seconds = settings.store.timer;
    if (!seconds || optimistic || !message?.id || pending[message.id]) return;
    if (message.author?.id !== UserStore.getCurrentUser()?.id) return;

    pending[message.id] = { channelId: message.channel_id, at: Date.now() + seconds * 1000 };
    savePending();
    schedule(message.id, seconds * 1000);
    emit();
}

async function resumePending() {
    pending = (await DataStore.get<Record<string, Pending>>(PENDING_KEY)) ?? {};
    // overdue ones (Discord was closed) go first, spaced out to stay under the delete rate limit
    let overdue = 0;
    for (const [id, p] of Object.entries(pending)) {
        const wait = p.at - Date.now();
        schedule(id, wait > 0 ? wait : overdue++ * 1200);
    }
    if (overdue) toast(`SafeSend: deleting ${overdue} message${overdue === 1 ? "" : "s"} whose timer ran out while Discord was closed`, "message");
    emit();
}

// ---------- delete messages in a channel ----------

interface Job { channelId: string; where: string; done: number; stopping: boolean; }
let job: Job | null = null;

const RANGES: { label: string; ms: number; }[] = [
    { label: "Last hour", ms: 3_600_000 },
    { label: "Last 24 hours", ms: 86_400_000 },
    { label: "Last 7 days", ms: 604_800_000 },
    { label: "Everything", ms: 0 }
];

const DISCORD_EPOCH = 1_420_070_400_000;
const messageTime = (id: string) => Number(BigInt(id) >> 22n) + DISCORD_EPOCH;
const snowflakeAt = (time: number) => (BigInt(Math.max(0, time - DISCORD_EPOCH)) << 22n).toString();

const channelLabel = (channelId: string) => {
    const ch = ChannelStore.getChannel(channelId) as any;
    return ch?.name ? `#${ch.name}` : "this DM";
};

// Discord search finds only YOUR messages directly, so we don't have to scroll the whole history
async function searchMine(channelId: string, me: string, cutoff: number) {
    const guildId = ChannelStore.getChannel(channelId)?.guild_id;
    const url = guildId ? `/guilds/${guildId}/messages/search` : `/channels/${channelId}/messages/search`;
    const query = { author_id: me, include_nsfw: true, ...(guildId ? { channel_id: channelId } : {}), ...(cutoff ? { min_id: snowflakeAt(cutoff) } : {}) };
    for (let tries = 0; tries < 5; tries++) {
        const res: any = await RestAPI.get({ url, query } as any);
        if (res.status !== 202) return (res.body?.messages ?? []).map((g: any[]) => g[0]) as any[];
        await sleep((res.body?.retry_after ?? 2) * 1000); // still indexing
    }
    throw new Error("search index not ready");
}

const HISTORY_PAGES = 50; // read the newest 5000 messages directly; search covers anything older
const HISTORY_PAGES_EVERYONE = 300; // "everyone" mode has no search shortcut, so read further back

// Discord only lets you delete other people's messages with Manage Messages in that channel
function canDeleteOthers(channelId: string) {
    const ch = ChannelStore.getChannel(channelId);
    return !!ch?.guild_id && PermissionStore.can(PermissionsBits.MANAGE_MESSAGES, ch);
}

async function runDelete(channelId: string, everyone: boolean, rangeMs: number) {
    const me = UserStore.getCurrentUser()?.id;
    if (!me) return;
    if (job) return toast("SafeSend is already deleting messages, stop that first", "failure");

    const j: Job = job = { channelId, where: channelLabel(channelId), done: 0, stopping: false };
    const cutoff = rangeMs ? Date.now() - rangeMs : 0;
    const tried = new Set<string>();
    emit();

    const del = async (id: string) => {
        if (tried.has(id) || j.stopping) return;
        tried.add(id); // never retry one that failed (e.g. system messages)
        try {
            await MessageActions.deleteMessage(channelId, id);
            j.done++;
            emit();
        } catch (e) {
            logger.warn("couldn't delete", id, e);
        }
        await sleep(1100); // stay under Discord's delete rate limit
    };

    try {
        // 1) walk the channel history directly: always includes brand-new messages and VC chats,
        //    which Discord search hasn't indexed (or doesn't index at all)
        let before: string | undefined;
        let finished = false;
        for (let page = 0; page < (everyone ? HISTORY_PAGES_EVERYONE : HISTORY_PAGES) && !j.stopping && !finished; page++) {
            const { body } = await RestAPI.get({ url: `/channels/${channelId}/messages`, query: { limit: 100, ...(before ? { before } : {}) } } as any);
            if (!body?.length) { finished = true; break; }
            before = body[body.length - 1].id;
            for (const m of body) {
                if (cutoff && messageTime(m.id) < cutoff) { finished = true; break; }
                if (everyone || m.author?.id === me) await del(m.id);
            }
            if (body.length < 100) finished = true;
        }

        // 2) older than that: use search (finds only yours, no need to read everything)
        if (!finished && !everyone) {
            try {
                while (!j.stopping) {
                    const messages = await searchMine(channelId, me, cutoff);
                    const batch = messages.filter(m => m.author?.id === me && m.channel_id === channelId && !tried.has(m.id));
                    if (!batch.length) break;
                    for (const m of batch) await del(m.id);
                    await sleep(1500); // let search catch up before the next page
                }
            } catch (e) {
                logger.warn("search unavailable for this channel, older messages skipped", e);
                toast("Older messages couldn't be searched here: only the newest 5000 were checked", "failure");
            }
        }
        toast(`${j.stopping ? "Stopped" : "Done"}: deleted ${j.done} message${j.done === 1 ? "" : "s"} in ${j.where}`, "success");
    } catch (e) {
        logger.error("delete failed", e);
        toast(`Stopped after ${j.done}: Discord refused or rate-limited, try again later`, "failure");
    } finally {
        job = null;
        emit();
    }
}

function DeleteModal({ modalProps, channelId }: { modalProps: RenderModalProps; channelId: string; }) {
    const where = channelLabel(channelId);
    const allowEveryone = canDeleteOthers(channelId);
    const [range, setRange] = useState(RANGES[1].ms);
    const [everyone, setEveryone] = useState(false);
    const rangeText = RANGES.find(r => r.ms === range)!.label.toLowerCase();
    const whose = everyone ? "everyone's messages" : "your messages";

    const go = () => {
        modalProps.onClose();
        runDelete(channelId, everyone, range);
    };

    return (
        <Modal
            {...modalProps}
            title={`Delete messages in ${where}`}
            actions={[
                { text: everyone ? "Delete everyone's messages" : "Delete my messages", variant: "danger", onClick: go },
                { text: "Cancel", variant: "secondary", onClick: modalProps.onClose }
            ]}
        >
            <div className="vc-ss-modal">
                <div className="vc-ss-field">How far back</div>
                <div className="vc-ss-chips" role="group" aria-label="How far back">
                    {RANGES.map(r => (
                        <button key={r.ms} className={"vc-ss-chip" + (r.ms === range ? " vc-ss-chip-on" : "")} aria-pressed={r.ms === range} onClick={() => setRange(r.ms)}>{r.label}</button>
                    ))}
                </div>
                {allowEveryone && (
                    <>
                        <div className="vc-ss-field">Whose messages</div>
                        <div className="vc-ss-chips" role="group" aria-label="Whose messages">
                            <button className={"vc-ss-chip" + (!everyone ? " vc-ss-chip-on" : "")} aria-pressed={!everyone} onClick={() => setEveryone(false)}>Only mine</button>
                            <button className={"vc-ss-chip vc-ss-chip-danger" + (everyone ? " vc-ss-chip-on" : "")} aria-pressed={everyone} onClick={() => setEveryone(true)}>Everyone's</button>
                        </div>
                    </>
                )}
                <div className={"vc-ss-summary" + (everyone ? " vc-ss-summary-danger" : "")}>
                    Deletes <b>{whose}</b> in <b>{where}</b> from <b>{range ? `the ${rangeText}` : "the whole history"}</b>, about one per second.
                    It keeps running in the background and you can stop it from the SafeSend button. <b>This can't be undone.</b>
                </div>
            </div>
        </Modal>
    );
}

// ---------- edit warning ----------

// resolves true = cancel the edit
function confirmEdit(channelId: string, messageId: string, content: string): Promise<boolean> {
    return new Promise(resolve => {
        confirmDialog({
            title: "Edits are logged",
            body: "People using a message logger keep the original text and every edit. Delete the message and send the new text as a fresh one instead? (A resent message loses its reply and attachments.)",
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

// speech bubble with a padlock inside
function LockIcon({ height = 24, width = 24, className }: IconProps) {
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
    stop: ["M6 6h12v12H6z"]
};

function SsIcon({ name }: { name: string; }) {
    return (
        <svg viewBox="0 0 24 24" width={20} height={20} fill="none" stroke="currentColor"
            strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            {SS_ICONS[name].map((d, i) => <path key={i} d={d} />)}
        </svg>
    );
}

function SafeSendPanel({ channelId, close }: { channelId: string; close: () => void; }) {
    const { timer, warnOnEdit } = settings.use(["timer", "warnOnEdit"]);
    useLive();
    const waiting = Object.keys(pending).length;

    return (
        <div className="vc-ss-popout" role="dialog" aria-label="SafeSend">
            <div className="vc-ss-title">Self-destruct my messages</div>
            <div className="vc-ss-timers" role="group" aria-label="Self-destruct timer">
                {TIMERS.map(t => (
                    <button
                        key={t.value}
                        className={"vc-ss-tool" + (timer === t.value ? " vc-ss-active" : "")}
                        aria-pressed={timer === t.value}
                        title={t.label}
                        onClick={() => { settings.store.timer = t.value; }}
                    >
                        <SsIcon name={t.value ? "timer" : "off"} />
                        <span>{timerLabel(t.value)}</span>
                    </button>
                ))}
            </div>
            <div className="vc-ss-hint">
                {timer
                    ? <>Everything you send, in any chat, deletes itself after <b>{TIMERS.find(t => t.value === timer)?.label}</b>.</>
                    : "Off: your messages stay until you delete them."}
                {waiting > 0 && <> <b>{waiting}</b> message{waiting === 1 ? "" : "s"} waiting to be deleted.</>}
            </div>

            <div className="vc-ss-sep" />
            <button className="vc-ss-row" role="switch" aria-checked={warnOnEdit} onClick={() => { settings.store.warnOnEdit = !warnOnEdit; }}>
                <span>Warn me before I edit a message</span>
                <span className={"vc-ss-switch" + (warnOnEdit ? " vc-ss-switch-on" : "")} />
            </button>

            <div className="vc-ss-sep" />
            {job
                ? (
                    <div className="vc-ss-job">
                        <div className="vc-ss-job-text">
                            <b>{job.stopping ? "Stopping…" : `Deleting in ${job.where}`}</b>
                            <span>{job.done} deleted so far</span>
                        </div>
                        <button className="vc-ss-tool vc-ss-danger" disabled={job.stopping} onClick={() => { if (job) { job.stopping = true; emit(); } }}>
                            <SsIcon name="stop" /><span>Stop</span>
                        </button>
                    </div>
                )
                : (
                    <button className="vc-ss-tool vc-ss-danger" onClick={() => { close(); openModal(p => <ErrorBoundary><DeleteModal modalProps={p} channelId={channelId} /></ErrorBoundary>); }}>
                        <SsIcon name="trash" /><span>Delete messages in this chat…</span>
                    </button>
                )}
        </div>
    );
}

const SafeSendButton: ChatBarButtonFactory = ({ channel }) => {
    const { timer } = settings.use(["timer"]);
    useLive();
    const buttonRef = useRef(null);
    const [show, setShow] = useState(false);
    if (!channel) return null;

    const tooltip = job
        ? `SafeSend: deleting in ${job.where} (${job.done} so far)`
        : timer ? `SafeSend: self-destruct after ${TIMERS.find(t => t.value === timer)?.label}` : "SafeSend";
    return (
        <Popout
            position="top"
            align="right"
            animation={Popout.Animation.SCALE}
            spacing={8}
            shouldShow={show}
            onRequestClose={() => setShow(false)}
            targetElementRef={buttonRef}
            renderPopout={({ closePopout }) => <ErrorBoundary><SafeSendPanel channelId={channel.id} close={closePopout} /></ErrorBoundary>}
        >
            {() => (
                <ChatBarButton tooltip={tooltip} onClick={() => setShow(v => !v)}>
                    <span ref={buttonRef} className={`vc-safesend-btn${timer ? " vc-safesend-on" : ""}`}>
                        <LockIcon />
                        {job
                            ? <span className="vc-safesend-badge vc-safesend-badge-busy">{job.done}</span>
                            : timer ? <span className="vc-safesend-badge">{timerLabel(timer)}</span> : null}
                    </span>
                </ChatBarButton>
            )}
        </Popout>
    );
};

export default definePlugin({
    name: "SafeSend",
    description: "Protect your own messages: self-destruct timer, warn before edits, delete your messages in a channel",
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
        resumePending().catch(e => logger.error("couldn't resume pending deletes", e));
    },

    stop() {
        FluxDispatcher.unsubscribe("MESSAGE_CREATE", onMessageCreate);
        // timers stop, but the list stays on disk and is picked up again on the next start
        timers.forEach(t => clearTimeout(t));
        timers.clear();
        if (job) job.stopping = true;
    }
});
