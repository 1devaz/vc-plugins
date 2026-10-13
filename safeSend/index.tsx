/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./style.css";

import { ChatBarButton, ChatBarButtonFactory } from "@api/ChatButtons";
import { definePluginSettings } from "@api/Settings";
import ErrorBoundary from "@components/ErrorBoundary";
import { sendMessage } from "@utils/discord";
import { Logger } from "@utils/Logger";
import definePlugin, { IconProps, OptionType } from "@utils/types";
import type { RenderModalProps } from "@vencord/discord-types";
import {
    Alerts, ChannelStore, ContextMenuApi, DraftType, FluxDispatcher, Menu, MessageActions, Modal, openModal, RestAPI,
    PermissionsBits, PermissionStore, SelectedChannelStore, showToast, Text, UploadHandler, UserStore, useState
} from "@webpack/common";

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
    },
    imageTheme: {
        type: OptionType.SELECT,
        description: "Colors for 'Send as image'",
        options: [
            { label: "Dark", value: "dark", default: true },
            { label: "Light", value: "light" }
        ]
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

// ---------- send as image ----------

function wrapLines(ctx: CanvasRenderingContext2D, text: string, maxWidth: number) {
    const out: string[] = [];
    for (const para of text.split("\n")) {
        let line = "";
        for (const word of para.split(/(\s+)/)) {
            const next = line + word;
            if (ctx.measureText(next).width > maxWidth && line.trim()) {
                out.push(line.trimEnd());
                line = word.trimStart();
            } else line = next;
        }
        out.push(line);
    }
    return out;
}

async function textToPng(text: string): Promise<File> {
    const dark = settings.store.imageTheme !== "light";
    const font = "500 22px 'gg sans', 'Noto Sans', 'Segoe UI', sans-serif";
    const pad = 28, lineH = 32, maxW = 640;

    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d")!;
    ctx.font = font;
    const lines = wrapLines(ctx, text, maxW);
    const width = Math.min(maxW, Math.max(...lines.map(l => ctx.measureText(l).width))) + pad * 2;

    const scale = 2; // sharp on high-dpi screens
    canvas.width = Math.ceil(width * scale);
    canvas.height = Math.ceil((lines.length * lineH + pad * 2 - 8) * scale);
    ctx.scale(scale, scale);
    ctx.fillStyle = dark ? "#2b2d31" : "#ffffff";
    ctx.beginPath();
    ctx.roundRect(0, 0, canvas.width / scale, canvas.height / scale, 16);
    ctx.fill();
    ctx.font = font;
    ctx.fillStyle = dark ? "#f2f3f5" : "#1e1f22";
    ctx.textBaseline = "top";
    lines.forEach((l, i) => ctx.fillText(l, pad, pad + i * lineH));

    const blob = await new Promise<Blob>((res, rej) => canvas.toBlob(b => (b ? res(b) : rej(new Error("toBlob failed"))), "image/png"));
    return new File([blob], "message.png", { type: "image/png" });
}

function ImageModal({ modalProps, channelId }: { modalProps: RenderModalProps; channelId: string; }) {
    const [text, setText] = useState("");
    const submit = async () => {
        if (!text.trim()) return;
        try {
            const file = await textToPng(text.trim());
            UploadHandler.promptToUpload([file], ChannelStore.getChannel(channelId), DraftType.ChannelMessage);
            modalProps.onClose();
            showToast("Image added: press Enter to send it", "success");
        } catch (e) {
            logger.error("image failed", e);
            showToast("Couldn't make the image", "failure");
        }
    };
    return (
        <Modal {...modalProps} title="Send as image" actions={[{ text: "Make image", variant: "primary", onClick: submit }]}>
            <div className="vc-safesend-body">
                <Text variant="text-sm/normal">
                    Message loggers keep text forever, but images only as a link. Once you delete an image, Discord removes the file and it stops loading for them
                    (unless they already opened it).
                </Text>
                <textarea
                    className="vc-safesend-textarea"
                    value={text}
                    autoFocus
                    onChange={e => setText(e.currentTarget.value)}
                    onKeyDown={e => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) submit(); }}
                    placeholder="Type your message… (Ctrl+Enter to make the image)"
                />
            </div>
        </Modal>
    );
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
    Alerts.show({
        title: `Delete EVERY message in ${where}?`,
        body: `All messages from everyone in ${where} will be deleted, about 1 per second in the background. This can't be undone.`,
        confirmText: "Delete everything",
        cancelText: "Cancel",
        onConfirm: () => { showToast(`Deleting all messages in ${where}…`, "message"); deleteAllMine(channelId, true); }
    } as any);
}

function confirmDeleteAll(channelId: string) {
    const ch = ChannelStore.getChannel(channelId) as any;
    const where = ch?.name ? `#${ch.name}` : "this DM";
    Alerts.show({
        title: "Delete ALL your messages?",
        body: `Every message you ever sent in ${where} will be deleted (about 1 per second, keeps going in the background). Other people's messages are not touched. This can't be undone.`,
        confirmText: "Delete all",
        cancelText: "Cancel",
        onConfirm: () => { showToast(`Deleting all your messages in ${where}…`, "message"); deleteAllMine(channelId); }
    } as any);
}

// ---------- edit warning ----------

function confirmEdit(channelId: string, messageId: string, content: string): Promise<boolean> {
    // resolves true = cancel the edit
    return new Promise(resolve => {
        Alerts.show({
            title: "Edits are logged",
            body: "People using a message logger keep the original text and every edit. Delete the message and send the new text as a fresh one instead?",
            confirmText: "Delete + resend",
            cancelText: "Edit anyway",
            onConfirm: () => {
                MessageActions.deleteMessage(channelId, messageId);
                sendMessage(channelId, { content });
                resolve(true);
            },
            onCancel: () => resolve(false),
            onCloseCallback: () => resolve(false)
        } as any);
    });
}

// ---------- chat bar button ----------

function LockIcon({ height = 20, width = 20, className }: IconProps) {
    return (
        <svg width={width} height={height} viewBox="0 0 24 24" className={className}>
            <path fill="currentColor" d="M17 9V7A5 5 0 0 0 7 7v2a3 3 0 0 0-3 3v7a3 3 0 0 0 3 3h10a3 3 0 0 0 3-3v-7a3 3 0 0 0-3-3ZM9 7a3 3 0 0 1 6 0v2H9V7Zm4 10.73V19h-2v-1.27a2 2 0 1 1 2 0Z" />
        </svg>
    );
}

function openMenu(e: React.MouseEvent, channelId: string) {
    ContextMenuApi.openContextMenu(e as any, () => (
        <Menu.Menu navId="vc-safesend" onClose={ContextMenuApi.closeContextMenu} aria-label="SafeSend">
            <Menu.MenuGroup label="Self-destruct my messages">
                {TIMERS.map(t => (
                    <Menu.MenuRadioItem
                        key={t.value}
                        id={`vc-safesend-t-${t.value}`}
                        group="vc-safesend-timer"
                        label={t.label}
                        checked={settings.store.timer === t.value}
                        action={() => {
                            settings.store.timer = t.value;
                            showToast(t.value ? `Self-destruct on: ${t.label}` : "Self-destruct off", "success");
                        }}
                    />
                ))}
            </Menu.MenuGroup>
            <Menu.MenuGroup>
                <Menu.MenuItem id="vc-safesend-image" label="🖼️ Send as image…" action={() => openModal(p => <ErrorBoundary><ImageModal modalProps={p} channelId={channelId} /></ErrorBoundary>)} />
                {deleting
                    ? <Menu.MenuItem id="vc-safesend-stop" label="⏹ Stop deleting" color="danger" action={() => { stopRequested = true; }} />
                    : <>
                        <Menu.MenuItem id="vc-safesend-delete" label="🗑️ Delete all my messages here" color="danger" action={() => confirmDeleteAll(channelId)} />
                        {canDeleteOthers(channelId) && (
                            <Menu.MenuItem id="vc-safesend-delete-all" label="🧨 Delete ALL messages here (everyone's)" color="danger" action={() => confirmDeleteEveryone(channelId)} />
                        )}
                    </>}
            </Menu.MenuGroup>
        </Menu.Menu>
    ));
}

const SafeSendButton: ChatBarButtonFactory = ({ channel }) => {
    const { timer } = settings.use(["timer"]);
    if (!channel) return null;
    const open = (e: React.MouseEvent) => openMenu(e, channel.id);
    return (
        <ChatBarButton tooltip={timer ? `SafeSend: self-destruct ${TIMERS.find(t => t.value === timer)?.label}` : "SafeSend"} onClick={open} onContextMenu={open}>
            <span className={`vc-safesend-btn${timer ? " vc-safesend-on" : ""}`}>
                <LockIcon />
                {timer ? <span className="vc-safesend-badge">{timerLabel(timer)}</span> : null}
            </span>
        </ChatBarButton>
    );
};

export default definePlugin({
    name: "SafeSend",
    description: "Protect your own messages: self-destruct timer, send text as an image, warn before edits, delete all your messages in a channel",
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
