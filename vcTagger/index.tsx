/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./style.css";

import { NavContextMenuPatchCallback } from "@api/ContextMenu";
import { showNotification } from "@api/Notifications";
import { definePluginSettings } from "@api/Settings";
import ErrorBoundary from "@components/ErrorBoundary";
import { Logger } from "@utils/Logger";
import definePlugin, { OptionType } from "@utils/types";
import type { RenderModalProps, User } from "@vencord/discord-types";
import { findStoreLazy } from "@webpack";
import { Menu, openModal, RestAPI, SelectedChannelStore, showToast, Tooltip, UserStore, useState, VoiceStateStore } from "@webpack/common";

import { Modal, Text, TextInput } from "./ui";

const logger = new Logger("VcTagger");
/** deep plain copy: settings.store hands out live proxies, and proxies can't be saved to disk ("could not be cloned") */
const plain = <T,>(v: T): T => JSON.parse(JSON.stringify(v ?? {}));

/** Discord's newer TextInput sometimes calls onChange with an event instead of the text */
const inputText = (v: any): string => typeof v === "string" ? v : v?.currentTarget?.value ?? v?.target?.value ?? "";
const NoteStore = findStoreLazy("NoteStore");

interface Tag {
    label: string;
    note?: string;
    date: number;
}

const settings = definePluginSettings({
    defaultLabel: {
        type: OptionType.STRING,
        description: "Default tag text when you quick-tag someone",
        default: "KICKED ME"
    },
    noteKeywords: {
        type: OptionType.STRING,
        description: "Comma-separated words. If your Discord note on a user contains one of them, they're treated as tagged too (leave empty to disable)",
        default: "kick,kicked,rejected,reject"
    },
    notifyOnJoin: {
        type: OptionType.BOOLEAN,
        description: "Show a popup when a tagged user joins your voice channel",
        default: true
    },
    showInMemberList: {
        type: OptionType.BOOLEAN,
        description: "Show the tag in the member list",
        default: true
    },
    showInChat: {
        type: OptionType.BOOLEAN,
        description: "Show the tag next to names in chat",
        default: false
    },
    tags: {
        type: OptionType.CUSTOM,
        default: {} as Record<string, Tag>
    }
});

// ---------- data ----------

function getManualTag(userId: string): Tag | undefined {
    return settings.store.tags[userId];
}

function setTag(userId: string, label: string, note?: string) {
    settings.store.tags = { ...plain(settings.store.tags), [userId]: { label, note: note || undefined, date: Date.now() } };
    scheduleTileScan();
}

function removeTag(userId: string) {
    const { [userId]: _, ...rest } = plain(settings.store.tags);
    settings.store.tags = rest;
    scheduleTileScan();
}

function keywords() {
    return settings.store.noteKeywords.split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
}

const fetchedNotes = new Map<string, string>();

function getNoteText(userId: string): string | undefined {
    try {
        return NoteStore.getNote(userId)?.note || fetchedNotes.get(userId) || undefined;
    } catch {
        return fetchedNotes.get(userId);
    }
}

/** Tag from the user's Discord note, if it contains a keyword */
function getNoteTag(userId: string): Tag | undefined {
    const note = getNoteText(userId);
    if (!note) return;
    const lower = note.toLowerCase();
    const hit = keywords().find(k => lower.includes(k));
    if (!hit) return;
    return { label: hit.toUpperCase(), note, date: 0 };
}

function getTag(userId: string): Tag | undefined {
    return getManualTag(userId) ?? getNoteTag(userId);
}

const requestedNotes = new Set<string>();
/** Discord only loads notes when you open a profile, so fetch it ourselves (once per session) */
async function ensureNoteLoaded(userId: string) {
    if (!keywords().length || requestedNotes.has(userId)) return;
    requestedNotes.add(userId);
    if (getNoteText(userId) !== undefined) return;
    try {
        const { body } = await RestAPI.get({ url: `/users/@me/notes/${userId}` });
        if (body?.note) fetchedNotes.set(userId, body.note);
    } catch {
        // 404 = no note
    }
}

function useTag(userId: string) {
    const { tags } = settings.use(["tags", "noteKeywords"]);
    const [, force] = useState(0);
    const manual = tags[userId];
    if (!manual && !requestedNotes.has(userId) && keywords().length) {
        ensureNoteLoaded(userId).then(() => force(x => x + 1));
    }
    return manual ?? getNoteTag(userId);
}

// ---------- UI ----------

function TagBadge({ userId, compact, prefix }: { userId: string; compact?: boolean; prefix?: boolean; }) {
    const tag = useTag(userId);
    if (!tag) return null;

    const tip = tag.note ? `${tag.label} — ${tag.note}` : tag.label;
    return (
        <Tooltip text={tip}>
            {props => (
                <span
                    {...props}
                    className={"vc-vctagger-badge" + (compact ? " vc-vctagger-compact" : "") + (prefix ? " vc-vctagger-prefix" : "")}
                    onClick={e => { e.stopPropagation(); openTagModal(UserStore.getUser(userId)); }}
                >
                    ⚠ {tag.label}
                </span>
            )}
        </Tooltip>
    );
}

function TagModal({ user, modalProps }: { user: User; modalProps: RenderModalProps; }) {
    const existing = getManualTag(user.id);
    const [label, setLabel] = useState(existing?.label ?? settings.store.defaultLabel);
    const [note, setNote] = useState(existing?.note ?? "");

    const save = () => {
        const l = inputText(label).trim();
        if (!l) return showToast("Type a tag first", "failure");
        try {
            setTag(user.id, l, inputText(note).trim());
            showToast(`Tagged ${(user as any).globalName ?? user.username} as ${l}`, "success");
        } catch (e) {
            logger.error("saving tag failed", e);
            showToast("Couldn't save the tag, see console (Ctrl+Shift+I)", "failure");
        }
        modalProps.onClose();
    };

    const actions: any[] = [{ text: "Save", variant: "primary", onClick: save }];
    if (existing) actions.push({
        text: "Remove tag",
        variant: "critical-secondary",
        onClick: () => { removeTag(user.id); showToast("Tag removed", "success"); modalProps.onClose(); }
    });

    return (
        <Modal {...modalProps} title={`Tag ${(user as any).globalName ?? user.username}`} actions={actions}>
            <div className="vc-vctagger-modal">
                <Text variant="text-sm/semibold">Tag (shown next to their name)</Text>
                <TextInput value={label} onChange={v => setLabel(inputText(v))} placeholder="KICKED ME" autoFocus />
                <Text variant="text-sm/semibold">Details (optional, shown on hover)</Text>
                <TextInput value={note} onChange={v => setNote(inputText(v))} placeholder="e.g. kicked me from Gaming VC on 10/09" />
            </div>
        </Modal>
    );
}

function openTagModal(user: User | undefined) {
    if (!user) return;
    openModal(props => <ErrorBoundary><TagModal user={user} modalProps={props} /></ErrorBoundary>);
}

const userContextPatch: NavContextMenuPatchCallback = (children, { user }: { user?: User; }) => {
    if (!user || user.id === UserStore.getCurrentUser()?.id) return;
    const tagged = !!getManualTag(user.id);

    children.push(
        <Menu.MenuSeparator />,
        <Menu.MenuItem id="vc-vctagger" label={tagged ? "Edit VC Tag" : "VC Tag"}>
            {!tagged && (
                <Menu.MenuItem
                    id="vc-vctagger-quick"
                    label={`Quick tag: "${settings.store.defaultLabel}"`}
                    action={() => { setTag(user.id, settings.store.defaultLabel); showToast(`Tagged ${user.username}`, "success"); }}
                />
            )}
            <Menu.MenuItem id="vc-vctagger-edit" label={tagged ? "Edit tag…" : "Custom tag…"} action={() => openTagModal(user)} />
            {tagged && (
                <Menu.MenuItem id="vc-vctagger-remove" label="Remove tag" color="danger" action={() => removeTag(user.id)} />
            )}
        </Menu.MenuItem>
    );
};

// ---------- plugin ----------

export default definePlugin({
    name: "VcTagger",
    description: "Tag users (e.g. who kicked you) and see the tag next to their name in voice channels, with an alert when they join your VC",
    authors: [{ name: "you", id: 0n }],
    dependencies: ["MemberListDecoratorsAPI", "MessageDecorationsAPI"],
    settings,

    patches: [
        // Voice channel user list (sidebar): add badge after the name
        {
            find: "#{intl::GUEST_NAME_SUFFIX})]",
            replacement: {
                // put the badge *before* the name so the "…" truncation of long names can't hide it
                match: /(?=\i\?\?\i\.\i\.getName\((\i)\),.{0,80}?#{intl::GUEST_NAME_SUFFIX})/,
                replace: "$self.renderVoiceBadge($1),"
            }
        }
    ],

    contextMenus: {
        "user-context": userContextPatch,
        "user-profile-actions": userContextPatch
    },

    /** used by VcQuickKick (auto-reject) */
    getTag(userId: string) {
        return getTag(userId);
    },

    async getTagAsync(userId: string) {
        if (!getManualTag(userId)) await ensureNoteLoaded(userId);
        return getTag(userId);
    },

    renderVoiceBadge(user: User) {
        if (!user?.id) return null;
        return (
            <ErrorBoundary noop key="vc-vctagger">
                <TagBadge userId={user.id} compact prefix />
            </ErrorBoundary>
        );
    },

    renderMemberListDecorator({ user }) {
        if (!user || !settings.store.showInMemberList) return null;
        return <TagBadge userId={user.id} compact />;
    },

    renderMessageDecoration({ message }) {
        if (!message?.author || !settings.store.showInChat) return null;
        return <TagBadge userId={message.author.id} compact />;
    },

    start() {
        tileObserver = new MutationObserver(scheduleTileScan);
        tileObserver.observe(document.body, { childList: true, subtree: true });
        scheduleTileScan();
    },

    stop() {
        tileObserver?.disconnect();
        tileObserver = null;
        document.querySelectorAll(".vc-vctagger-tile").forEach(e => e.remove());
    },

    flux: {
        async VOICE_STATE_UPDATES({ voiceStates }: { voiceStates: { userId: string; channelId?: string; oldChannelId?: string; }[]; }) {
            scheduleTileScan();
            if (!settings.store.notifyOnJoin) return;
            const myChanId = SelectedChannelStore.getVoiceChannelId();
            const me = UserStore.getCurrentUser();
            if (!myChanId || !me) return;

            for (const { userId, channelId, oldChannelId } of voiceStates) {
                if (channelId !== myChanId || oldChannelId === myChanId) continue;
                try {
                    if (userId === me.id) {
                        // I just joined a VC: warn about tagged people already inside
                        const present = Object.keys(VoiceStateStore.getVoiceStatesForChannel(myChanId) ?? {}).filter(id => id !== me.id);
                        await Promise.all(present.map(id => getManualTag(id) ? null : ensureNoteLoaded(id)));
                        for (const id of present) {
                            const tag = getTag(id);
                            if (tag) alertTagged(id, tag, "is in this VC");
                        }
                        continue;
                    }

                    if (!getManualTag(userId)) await ensureNoteLoaded(userId);
                    const tag = getTag(userId);
                    if (tag) alertTagged(userId, tag, "joined your VC");
                } catch (e) {
                    logger.error("Failed to handle voice join", e);
                }
            }
        }
    }
});

function alertTagged(userId: string, tag: Tag, what: string) {
    const user = UserStore.getUser(userId);
    const name = (user as any)?.globalName ?? user?.username ?? userId;
    const body = tag.note ? `${tag.label} — ${tag.note}` : tag.label;
    // Discord focused: just a small toast. In background: system notification so you still see it.
    if (document.hasFocus()) {
        showToast(`⚠ ${name}: ${tag.label}`, "failure");
        return;
    }
    showNotification({
        title: `⚠ ${name} ${what}`,
        body,
        icon: user?.getAvatarURL?.(undefined, 128),
        color: "#ed4245",
        noPersist: true,
        onClick: () => openTagModal(user)
    });
}

// ---------- call tiles (the big video/avatar tiles) ----------

let tileObserver: MutationObserver | null = null;
let scanQueued = false;

function scheduleTileScan() {
    if (scanQueued) return;
    scanQueued = true;
    requestAnimationFrame(() => {
        scanQueued = false;
        try { scanTiles(); } catch (e) { logger.error("tile scan failed", e); }
    });
}

function scanTiles() {
    for (const tile of document.querySelectorAll<HTMLElement>("[data-selenium-video-tile]")) {
        const userId = tile.getAttribute("data-selenium-video-tile")!;
        const tag = getTag(userId);
        let badge = tile.querySelector<HTMLElement>(":scope > .vc-vctagger-tile");
        if (!tag) { badge?.remove(); continue; }
        const text = `⚠ ${tag.label}`;
        if (!badge) {
            badge = document.createElement("div");
            badge.className = "vc-vctagger-badge vc-vctagger-tile";
            tile.appendChild(badge);
        }
        if (badge.textContent !== text) badge.textContent = text;
        badge.title = tag.note ?? tag.label;
    }
}

