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
import { copyToClipboard } from "@utils/clipboard";
import { openUserProfile } from "@utils/discord";
import { Logger } from "@utils/Logger";
import definePlugin, { OptionType } from "@utils/types";
import type { RenderModalProps, User } from "@vencord/discord-types";
import { findStoreLazy } from "@webpack";
import { Menu, openModal, RestAPI, SelectedChannelStore, Tooltip, useEffect, UserStore, UserUtils, useState, VoiceStateStore } from "@webpack/common";

import { confirmDialog, Modal, Text, TextInput, toast } from "./ui";

const logger = new Logger("VcTagger");
// deep plain copy: settings.store hands out live proxies, and proxies can't be saved to disk ("could not be cloned")
const plain = <T,>(v: T): T => JSON.parse(JSON.stringify(v ?? {}));

// Discord's newer TextInput sometimes calls onChange with an event instead of the text
const inputText = (v: any): string => typeof v === "string" ? v : v?.currentTarget?.value ?? v?.target?.value ?? "";
const NoteStore = findStoreLazy("NoteStore");
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

interface Tag {
    label: string;
    note?: string;
    date: number;
    color?: string;
}

const COLORS: { name: string; css: string; dark?: boolean; }[] = [
    { name: "Red", css: "#ed4245" },
    { name: "Orange", css: "#e67e22" },
    { name: "Yellow", css: "#f0b232", dark: true },
    { name: "Green", css: "#23a55a" },
    { name: "Blue", css: "#5865f2" },
    { name: "Purple", css: "#9b59b6" },
    { name: "Gray", css: "#4e5058" }
];
const DEFAULT_COLOR = COLORS[0].css;
const MAX_LABEL = 24;

const badgeStyle = (tag: Tag) => {
    const c = COLORS.find(c => c.css === tag.color);
    return c ? { background: c.css, color: c.dark ? "#111214" : "#fff" } : undefined;
};

const settings = definePluginSettings({
    manage: {
        type: OptionType.COMPONENT,
        component: () => <button className="vc-vctagger-open" onClick={openManageModal}>Manage all tags…</button>
    },
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

const nameOf = (userId: string) => {
    const u = UserStore.getUser(userId) as any;
    return u?.globalName ?? u?.username ?? userId;
};

function ago(time: number) {
    const s = Math.max(0, Date.now() - time) / 1000;
    if (s < 60) return "just now";
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    if (s < 86_400) return `${Math.floor(s / 3600)}h ago`;
    return `${Math.floor(s / 86_400)}d ago`;
}

// ---------- data ----------

function getManualTag(userId: string): Tag | undefined {
    return settings.store.tags[userId];
}

function setTag(userId: string, label: string, note?: string, color?: string) {
    const tag: Tag = { label: label.slice(0, MAX_LABEL), note: note || undefined, date: Date.now(), color: color && color !== DEFAULT_COLOR ? color : undefined };
    settings.store.tags = { ...plain(settings.store.tags), [userId]: tag };
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

// Discord only loads notes when you open a profile, so we fetch them ourselves:
// once per user per session, one request at a time, so a full VC never bursts the API
const noteChecked = new Set<string>();
const noteWaiters = new Map<string, (() => void)[]>();
let notePumping = false;

const noteKnown = (userId: string) => !keywords().length || noteChecked.has(userId) || getNoteText(userId) !== undefined;

function ensureNoteLoaded(userId: string): Promise<void> {
    if (noteKnown(userId)) return Promise.resolve();
    return new Promise(resolve => {
        const waiting = noteWaiters.get(userId);
        if (waiting) return void waiting.push(resolve);
        noteWaiters.set(userId, [resolve]);
        pumpNotes();
    });
}

async function pumpNotes() {
    if (notePumping) return;
    notePumping = true;
    try {
        while (noteWaiters.size) {
            const [userId, waiters] = noteWaiters.entries().next().value!;
            try {
                const { body } = await RestAPI.get({ url: `/users/@me/notes/${userId}` });
                if (body?.note) fetchedNotes.set(userId, body.note);
                noteChecked.add(userId);
            } catch (e: any) {
                // 404 = no note. Anything else (rate limit, offline) is left unchecked so it's retried next time
                if (e?.status === 404) noteChecked.add(userId);
            }
            noteWaiters.delete(userId);
            waiters.forEach(f => f());
            await sleep(350);
        }
    } finally {
        notePumping = false;
    }
}

// fetchNote: only the voice list asks Discord for missing notes; member list and chat use what's already loaded
function useTag(userId: string, fetchNote: boolean) {
    const { tags } = settings.use(["tags", "noteKeywords"]);
    const [, force] = useState(0);
    const manual = tags[userId];
    const hasManual = !!manual;

    useEffect(() => {
        if (hasManual || !fetchNote || noteKnown(userId)) return;
        let alive = true;
        ensureNoteLoaded(userId).then(() => alive && force(x => x + 1));
        return () => { alive = false; };
    }, [userId, hasManual, fetchNote]);

    return manual ?? getNoteTag(userId);
}

function tagTooltip(tag: Tag) {
    const when = tag.date ? `tagged ${ago(tag.date)}` : "from your note";
    return tag.note ? `${tag.label} — ${tag.note} (${when})` : `${tag.label} (${when})`;
}

// ---------- UI ----------

function TagBadge({ userId, compact, prefix }: { userId: string; compact?: boolean; prefix?: boolean; }) {
    const tag = useTag(userId, !!prefix);
    if (!tag) return null;

    return (
        <Tooltip text={tagTooltip(tag)}>
            {props => (
                <span
                    {...props}
                    className={"vc-vctagger-badge" + (compact ? " vc-vctagger-compact" : "") + (prefix ? " vc-vctagger-prefix" : "")}
                    style={badgeStyle(tag)}
                    role="button"
                    aria-label={`Tag: ${tag.label}. Click to edit`}
                    onClick={e => { e.stopPropagation(); openTagModal(userId); }}
                >
                    ⚠ {tag.label}
                </span>
            )}
        </Tooltip>
    );
}

// labels you already use, most used first, for one-click reuse
function commonLabels() {
    const counts = new Map<string, number>();
    for (const t of Object.values(settings.store.tags) as Tag[]) counts.set(t.label, (counts.get(t.label) ?? 0) + 1);
    const sorted = [...counts].sort((a, b) => b[1] - a[1]).map(([l]) => l);
    return [...new Set([settings.store.defaultLabel, ...sorted])].filter(Boolean).slice(0, 6);
}

function TagModal({ userId, modalProps }: { userId: string; modalProps: RenderModalProps; }) {
    const existing = getManualTag(userId);
    const noteTag = existing ? undefined : getNoteTag(userId);
    const [label, setLabel] = useState(existing?.label ?? settings.store.defaultLabel);
    const [note, setNote] = useState(existing?.note ?? "");
    const [color, setColor] = useState(existing?.color ?? DEFAULT_COLOR);
    const name = nameOf(userId);
    const cleanLabel = inputText(label).trim();

    const save = () => {
        if (!cleanLabel) return toast("Type a tag first", "failure");
        try {
            setTag(userId, cleanLabel, inputText(note).trim(), color);
            toast(`Tagged ${name} as ${cleanLabel}`, "success");
        } catch (e) {
            logger.error("saving tag failed", e);
            toast("Couldn't save the tag, see console (Ctrl+Shift+I)", "failure");
        }
        modalProps.onClose();
    };

    const actions: any[] = [{ text: existing ? "Save changes" : "Save tag", variant: "primary", onClick: save, disabled: !cleanLabel }];
    if (existing) actions.push({
        text: "Remove tag",
        variant: "secondary",
        onClick: () => { removeTag(userId); toast(`Removed the tag from ${name}`, "success"); modalProps.onClose(); }
    });

    return (
        <Modal {...modalProps} title={`${existing ? "Edit tag" : "Tag"} · ${name}`} subtitle={existing ? `Tagged ${ago(existing.date)}` : undefined} actions={actions}>
            <div className="vc-vctagger-modal">
                {noteTag && (
                    <div className="vc-vctagger-hint">
                        Already shown as <b>{noteTag.label}</b> because your Discord note on them contains that word. Saving a tag here replaces it.
                    </div>
                )}
                <Text variant="text-sm/semibold">Tag (shown next to their name)</Text>
                <TextInput value={label} onChange={v => setLabel(inputText(v))} onEnter={save} placeholder="KICKED ME" maxLength={MAX_LABEL} autoFocus />
                <div className="vc-vctagger-chips">
                    {commonLabels().map(l => (
                        <button key={l} className={"vc-vctagger-chip" + (l === cleanLabel ? " vc-vctagger-chip-on" : "")} onClick={() => setLabel(l)}>{l}</button>
                    ))}
                </div>
                <Text variant="text-sm/semibold">Color</Text>
                <div className="vc-vctagger-chips">
                    {COLORS.map(c => (
                        <button
                            key={c.css}
                            className={"vc-vctagger-swatch" + (c.css === color ? " vc-vctagger-swatch-on" : "")}
                            style={{ background: c.css }}
                            title={c.name}
                            aria-label={c.name}
                            aria-pressed={c.css === color}
                            onClick={() => setColor(c.css)}
                        />
                    ))}
                    <span className="vc-vctagger-preview">
                        <span className="vc-vctagger-badge" style={badgeStyle({ label: "", date: 0, color })}>⚠ {cleanLabel || "TAG"}</span>
                    </span>
                </div>
                <Text variant="text-sm/semibold">Details (optional, shown on hover)</Text>
                <TextInput value={note} onChange={v => setNote(inputText(v))} onEnter={save} placeholder="e.g. kicked me from Gaming VC on 10/09" maxLength={200} />
            </div>
        </Modal>
    );
}

function openTagModal(userId: string | undefined) {
    if (!userId) return;
    openModal(props => <ErrorBoundary><TagModal userId={userId} modalProps={props} /></ErrorBoundary>);
}

// ---------- manage all tags ----------

const MANAGE_PAGE = 8;
const ID_RE = /^\d{15,21}$/;

function importTags(text: string): number {
    const data = JSON.parse(text);
    if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("not a tag list");
    const next: Record<string, Tag> = plain(settings.store.tags);
    let added = 0;
    for (const [id, raw] of Object.entries<any>(data)) {
        const label = typeof raw?.label === "string" ? raw.label.trim().slice(0, MAX_LABEL) : "";
        if (!ID_RE.test(id) || !label) continue;
        next[id] = {
            label,
            note: typeof raw.note === "string" && raw.note ? raw.note.slice(0, 200) : undefined,
            date: typeof raw.date === "number" ? raw.date : Date.now(),
            color: COLORS.some(c => c.css === raw.color) && raw.color !== DEFAULT_COLOR ? raw.color : undefined
        };
        added++;
    }
    settings.store.tags = next;
    scheduleTileScan();
    return added;
}

function ManageModal({ modalProps }: { modalProps: RenderModalProps; }) {
    const { tags } = settings.use(["tags"]);
    const [query, setQuery] = useState("");
    const [page, setPage] = useState(0);
    const [importing, setImporting] = useState(false);
    const [importText, setImportText] = useState("");
    const [, force] = useState(0);

    const q = query.trim().toLowerCase();
    const all = (Object.entries(tags) as [string, Tag][]).sort((a, b) => b[1].date - a[1].date);
    const filtered = all.filter(([id, t]) => !q || id.includes(q) || t.label.toLowerCase().includes(q) || !!t.note?.toLowerCase().includes(q) || nameOf(id).toLowerCase().includes(q));
    const pages = Math.max(1, Math.ceil(filtered.length / MANAGE_PAGE));
    const cur = Math.min(page, pages - 1);
    const rows = filtered.slice(cur * MANAGE_PAGE, (cur + 1) * MANAGE_PAGE);
    const rowIds = rows.map(([id]) => id).join(",");

    // people you haven't seen this session aren't in Discord's cache: load the visible ones so they show a name, not an ID
    useEffect(() => {
        let alive = true;
        (async () => {
            for (const id of rowIds ? rowIds.split(",") : []) {
                if (!alive) return;
                if (UserStore.getUser(id)) continue;
                try { await UserUtils.getUser(id); } catch { /* deleted account */ }
                if (alive) force(x => x + 1);
                await sleep(300);
            }
        })();
        return () => { alive = false; };
    }, [rowIds]);

    const doExport = async () => {
        await copyToClipboard(JSON.stringify(plain(tags), null, 2));
        toast(`Copied ${all.length} tag${all.length === 1 ? "" : "s"} to the clipboard`, "success");
    };
    const doImport = () => {
        try {
            const n = importTags(importText);
            toast(n ? `Imported ${n} tag${n === 1 ? "" : "s"}` : "No valid tags found in that text", n ? "success" : "failure");
            if (n) { setImporting(false); setImportText(""); }
        } catch {
            toast("That isn't a tag export (it should be the text you got from Export)", "failure");
        }
    };
    const removeAll = () => confirmDialog({
        title: `Remove all ${all.length} tags?`,
        body: "Every tag you added is deleted. Tags that come from your Discord notes stay. Use Export first if you want a backup.",
        confirmText: "Remove all",
        danger: true,
        onConfirm: () => { settings.store.tags = {}; scheduleTileScan(); toast("All tags removed", "success"); }
    });

    return (
        <Modal {...modalProps} title="VC tags" subtitle={`${all.length} tagged user${all.length === 1 ? "" : "s"}`} size="md">
            <div className="vc-vctagger-toolbar">
                <TextInput value={query} onChange={v => { setQuery(inputText(v)); setPage(0); }} placeholder="Search name, tag, note or ID…" autoFocus />
                <button className="vc-vctagger-tool" onClick={doExport} disabled={!all.length}>Export</button>
                <button className="vc-vctagger-tool" onClick={() => setImporting(v => !v)}>Import</button>
                <button className="vc-vctagger-tool vc-vctagger-tool-danger" onClick={removeAll} disabled={!all.length}>Remove all</button>
            </div>
            {importing && (
                <div className="vc-vctagger-import">
                    <textarea value={importText} onChange={e => setImportText(e.currentTarget.value)} placeholder="Paste the text from Export here. Existing tags for the same users are replaced." />
                    <button className="vc-vctagger-tool" onClick={doImport} disabled={!importText.trim()}>Import tags</button>
                </div>
            )}
            {all.length === 0 && <div className="vc-vctagger-empty">No tags yet. Right-click someone and pick <b>VC Tag</b> to add one.</div>}
            {all.length > 0 && rows.length === 0 && <div className="vc-vctagger-empty">Nothing matches “{query.trim()}”.</div>}
            {rows.map(([id, t]) => {
                const u = UserStore.getUser(id);
                return (
                    <div key={id} className="vc-vctagger-row">
                        {u
                            ? <img className="vc-vctagger-avatar" src={u.getAvatarURL(undefined, 64, false)} alt="" loading="lazy" onClick={() => openUserProfile(id)} title="View profile" />
                            : <div className="vc-vctagger-avatar vc-vctagger-avatar-none" />}
                        <div className="vc-vctagger-row-main">
                            <div className="vc-vctagger-row-line">
                                <span className="vc-vctagger-row-name">{nameOf(id)}</span>
                                <span className="vc-vctagger-badge vc-vctagger-compact vc-vctagger-static" style={badgeStyle(t)}>⚠ {t.label}</span>
                            </div>
                            <div className="vc-vctagger-row-meta">{t.note ? `${t.note} · ` : ""}{ago(t.date)} · {id}</div>
                        </div>
                        <button className="vc-vctagger-tool" onClick={() => openTagModal(id)}>Edit</button>
                        <button className="vc-vctagger-tool vc-vctagger-tool-danger" onClick={() => removeTag(id)} aria-label={`Remove tag from ${nameOf(id)}`}>Remove</button>
                    </div>
                );
            })}
            {pages > 1 && (
                <div className="vc-vctagger-pager">
                    <button className="vc-vctagger-tool" disabled={cur === 0} onClick={() => setPage(cur - 1)}>‹ Prev</button>
                    <span>Page {cur + 1} / {pages}</span>
                    <button className="vc-vctagger-tool" disabled={cur >= pages - 1} onClick={() => setPage(cur + 1)}>Next ›</button>
                </div>
            )}
        </Modal>
    );
}

function openManageModal() {
    openModal(props => <ErrorBoundary><ManageModal modalProps={props} /></ErrorBoundary>);
}

const userContextPatch: NavContextMenuPatchCallback = (children, { user }: { user?: User; }) => {
    if (!user || user.id === UserStore.getCurrentUser()?.id) return;
    const tagged = !!getManualTag(user.id);
    const name = nameOf(user.id);

    children.push(
        <Menu.MenuSeparator />,
        <Menu.MenuItem id="vc-vctagger" label={tagged ? "Edit VC Tag" : "VC Tag"}>
            {!tagged && (
                <Menu.MenuItem
                    id="vc-vctagger-quick"
                    label={`Quick tag: "${settings.store.defaultLabel}"`}
                    action={() => { setTag(user.id, settings.store.defaultLabel); toast(`Tagged ${name} as ${settings.store.defaultLabel}`, "success"); }}
                />
            )}
            <Menu.MenuItem id="vc-vctagger-edit" label={tagged ? "Edit tag…" : "Custom tag…"} action={() => openTagModal(user.id)} />
            {tagged && (
                <Menu.MenuItem id="vc-vctagger-remove" label="Remove tag" color="danger" action={() => { removeTag(user.id); toast(`Removed the tag from ${name}`, "success"); }} />
            )}
            <Menu.MenuItem id="vc-vctagger-manage" label="Manage all tags…" action={openManageModal} />
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

    toolboxActions: {
        "Manage VC tags": openManageModal
    },

    // used by VcQuickKick (auto-reject)
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
        noteWaiters.forEach(waiters => waiters.forEach(f => f()));
        noteWaiters.clear();
        lastAlert.clear();
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

const lastAlert = new Map<string, number>();

function alertTagged(userId: string, tag: Tag, what: string) {
    // Discord often sends several voice updates for one join: alert once
    if ((lastAlert.get(userId) ?? 0) > Date.now() - 10_000) return;
    lastAlert.set(userId, Date.now());

    const name = nameOf(userId);
    // Discord focused: just a small toast. In background: system notification so you still see it.
    if (document.hasFocus()) {
        toast(`⚠ ${name} ${what} · ${tag.label}`, "failure");
        return;
    }
    showNotification({
        title: `⚠ ${name} ${what}`,
        body: tag.note ? `${tag.label} — ${tag.note}` : tag.label,
        icon: UserStore.getUser(userId)?.getAvatarURL?.(undefined, 128),
        color: tag.color ?? DEFAULT_COLOR,
        noPersist: true,
        onClick: () => openTagModal(userId)
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
        const userId = tile.getAttribute("data-selenium-video-tile")?.match(/\d{15,21}/)?.[0];
        const tag = userId ? getTag(userId) : undefined;
        let badge = tile.querySelector<HTMLElement>(":scope > .vc-vctagger-tile");
        if (!tag) { badge?.remove(); continue; }
        if (!badge) {
            badge = document.createElement("div");
            badge.className = "vc-vctagger-badge vc-vctagger-tile";
            badge.setAttribute("role", "button");
            const el = badge;
            el.addEventListener("mousedown", e => e.stopPropagation());
            el.addEventListener("dblclick", e => { e.preventDefault(); e.stopPropagation(); });
            el.addEventListener("click", e => { e.preventDefault(); e.stopPropagation(); openTagModal(el.dataset.uid); });
            tile.appendChild(badge);
        }
        const text = `⚠ ${tag.label}`;
        const style = badgeStyle(tag);
        if (badge.textContent !== text) badge.textContent = text;
        badge.dataset.uid = userId;
        badge.title = `${tagTooltip(tag)} · click to edit`;
        badge.style.background = style?.background ?? "";
        badge.style.color = style?.color ?? "";
    }
}
