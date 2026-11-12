/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./style.css";

import { ChatBarButton, ChatBarButtonFactory } from "@api/ChatButtons";
import { definePluginSettings } from "@api/Settings";
import ErrorBoundary from "@components/ErrorBoundary";
import { copyToClipboard } from "@utils/clipboard";
import { insertTextIntoChatInputBox, sendMessage } from "@utils/discord";
import definePlugin, { IconProps, OptionType } from "@utils/types";
import { ChannelStore, DraftType, Popout, showToast, UploadHandler, UserStore, useRef, useState } from "@webpack/common";

const toast = (text: string, ok = true) => showToast({ text, variant: ok ? "success" : "critical" });

// Discord's ANSI palette (what everyone sees in ```ansi blocks)
const FG = [
    { code: 30, name: "Gray", css: "#4f545c" },
    { code: 31, name: "Red", css: "#dc322f" },
    { code: 32, name: "Green", css: "#859900" },
    { code: 33, name: "Yellow", css: "#b58900" },
    { code: 34, name: "Blue", css: "#268bd2" },
    { code: 35, name: "Pink", css: "#d33682" },
    { code: 36, name: "Cyan", css: "#2aa198" },
    { code: 37, name: "White", css: "#ffffff" }
];
const BG = [
    { code: 0, name: "None", css: "transparent" },
    { code: 40, name: "Night", css: "#002b36" },
    { code: 41, name: "Orange", css: "#cb4b16" },
    { code: 42, name: "Slate", css: "#586e75" },
    { code: 43, name: "Teal", css: "#657b83" },
    { code: 44, name: "Gray", css: "#839496" },
    { code: 45, name: "Indigo", css: "#6c71c4" },
    { code: 46, name: "Silver", css: "#93a1a1" },
    { code: 47, name: "Cream", css: "#fdf6e3" }
];
const RAINBOW = [31, 33, 32, 36, 34, 35];

type Mode = "solid" | "rainbow-letters" | "rainbow-words";
const MODES: { value: Mode; label: string; }[] = [
    { value: "solid", label: "One color" },
    { value: "rainbow-words", label: "Rainbow words" },
    { value: "rainbow-letters", label: "Rainbow letters" }
];

// ---------- unicode text styles: real different characters, so they show styled on EVERY device,
// phones included, not just where ANSI colors render ----------

type TextStyle = "none" | "bold" | "mono" | "fullwidth" | "smallcaps";

const TEXT_STYLES: { value: TextStyle; label: string; }[] = [
    { value: "none", label: "Normal" },
    { value: "bold", label: "𝗕𝗼𝗹𝗱" },
    { value: "mono", label: "𝚖𝚘𝚗𝚘" },
    { value: "fullwidth", label: "Ｗｉｄｅ" },
    { value: "smallcaps", label: "ᴄᴀᴘs" }
];

const SMALL_CAPS: Record<string, string> = {
    a: "ᴀ", b: "ʙ", c: "ᴄ", d: "ᴅ", e: "ᴇ", f: "ꜰ", g: "ɢ", h: "ʜ", i: "ɪ", j: "ᴊ",
    k: "ᴋ", l: "ʟ", m: "ᴍ", n: "ɴ", o: "ᴏ", p: "ᴘ", q: "ǫ", r: "ʀ", s: "s", t: "ᴛ",
    u: "ᴜ", v: "ᴠ", w: "ᴡ", x: "x", y: "ʏ", z: "ᴢ"
};

function applyTextStyle(text: string, style: TextStyle): string {
    if (style === "none") return text;
    let out = "";
    for (const c of text) {
        const code = c.codePointAt(0)!;
        if (style === "bold") {
            if (code >= 65 && code <= 90) out += String.fromCodePoint(0x1D5D4 + (code - 65));
            else if (code >= 97 && code <= 122) out += String.fromCodePoint(0x1D5EE + (code - 97));
            else if (code >= 48 && code <= 57) out += String.fromCodePoint(0x1D7EC + (code - 48));
            else out += c;
        } else if (style === "mono") {
            if (code >= 65 && code <= 90) out += String.fromCodePoint(0x1D670 + (code - 65));
            else if (code >= 97 && code <= 122) out += String.fromCodePoint(0x1D68A + (code - 97));
            else if (code >= 48 && code <= 57) out += String.fromCodePoint(0x1D7F6 + (code - 48));
            else out += c;
        } else if (style === "fullwidth") {
            out += (code >= 33 && code <= 126) ? String.fromCodePoint(code + 0xFEE0) : c;
        } else if (style === "smallcaps") {
            out += SMALL_CAPS[c.toLowerCase()] ?? c;
        }
    }
    return out;
}

// case transforms rewrite what you typed in the text box
const CASE_TRANSFORMS: { label: string; run(t: string): string; }[] = [
    { label: "UPPER", run: t => t.toUpperCase() },
    { label: "lower", run: t => t.toLowerCase() },
    { label: "Title", run: t => t.replace(/\S+/g, w => w[0].toUpperCase() + w.slice(1).toLowerCase()) },
    { label: "aLtErNaTe", run: t => [...t].map((c, i) => i % 2 ? c.toLowerCase() : c.toUpperCase()).join("") }
];

// ---------- what you picked last time is remembered ----------

interface Prefs {
    fg: number; bg: number; bold: boolean; underline: boolean; mode: Mode; textStyle: TextStyle;
    imgSize: number; customColors: boolean; imgFg: string; imgBg: string;
}

const DEFAULT_PREFS: Prefs = {
    fg: 31, bg: 0, bold: true, underline: false, mode: "solid", textStyle: "none",
    imgSize: 26, customColors: false, imgFg: "#ffffff", imgBg: "#2b2d31"
};

const settings = definePluginSettings({
    prefs: {
        type: OptionType.CUSTOM,
        default: DEFAULT_PREFS
    }
});

// kept while Discord is open, so closing the popout by accident doesn't lose what you typed
let draft = "";

const ESC = "\u001b";
const code = (...c: number[]) => `${ESC}[${c.join(";")}m`;

type Piece = { t: string; fg: number; };

function build(text: string, { fg, bg, bold, underline, mode }: Prefs) {
    const style = [bold ? 1 : 0, ...(underline ? [4] : [])];
    const withBg = (c: number[]) => (bg ? [...c, bg] : c);
    const pieces: Piece[] = [];

    if (mode === "solid") pieces.push({ t: text, fg });
    else {
        const parts = mode === "rainbow-letters" ? [...text] : text.split(/(\s+)/);
        let i = 0;
        for (const p of parts) {
            if (!p) continue;
            const last = pieces[pieces.length - 1];
            // spaces have no color of their own: glue them to the piece before, so they don't cost an extra color code
            if (!p.trim() && last) { last.t += p; continue; }
            pieces.push({ t: p, fg: p.trim() ? RAINBOW[i++ % RAINBOW.length] : fg });
        }
    }

    // a ``` inside the text would close the code block early
    const safe = (t: string) => t.replaceAll("```", "`​``");
    const body = pieces.map(p => code(...withBg([...style, p.fg])) + safe(p.t)).join("");
    return { ansi: "```ansi\n" + body + code(0) + "\n```", pieces };
}

const messageLimit = () => ((UserStore.getCurrentUser() as any)?.premiumType === 2 ? 4000 : 2000);

// ---------- render colored text to an image (so phones see the colors too) ----------

const fgCss = (code: number) => FG.find(f => f.code === code)?.css ?? "#ffffff";

// split pieces into draw parts; each whitespace char (including newlines) becomes its own part
function splitPieces(pieces: Piece[]) {
    const parts: Piece[] = [];
    for (const p of pieces) {
        for (const part of p.t.split(/(\s)/)) {
            if (part !== "") parts.push({ t: part, fg: p.fg });
        }
    }
    return parts;
}

async function renderImage(pieces: Piece[], bold: boolean, underline: boolean, bgCss: string | undefined, fontPx: number, fgOverride?: string): Promise<File> {
    const scale = 2;
    const lineH = Math.round(fontPx * 1.45), pad = Math.round(fontPx * 0.85), maxW = 680;
    const font = `${bold ? "700" : "500"} ${fontPx}px 'gg sans', 'Noto Sans', 'Segoe UI', Arial, sans-serif`;

    const measure = document.createElement("canvas").getContext("2d")!;
    measure.font = font;
    const parts = splitPieces(pieces);

    // layout pass: word-wrap, record a line number + x for each part
    type Placed = Piece & { x: number; line: number; w: number; };
    const placed: Placed[] = [];
    let x = 0, line = 0, usedW = 0;
    for (const pc of parts) {
        if (pc.t === "\n") { x = 0; line++; continue; }
        const w = measure.measureText(pc.t).width;
        if (x + w > maxW && x > 0 && pc.t.trim()) { x = 0; line++; }
        placed.push({ ...pc, x, line, w });
        x += w;
        usedW = Math.max(usedW, x);
    }

    const width = Math.ceil(Math.min(maxW, usedW) + pad * 2);
    const height = Math.ceil((line + 1) * lineH + pad * 2 - (lineH - fontPx));

    const canvas = document.createElement("canvas");
    canvas.width = width * scale;
    canvas.height = height * scale;
    const ctx = canvas.getContext("2d")!;
    ctx.scale(scale, scale);

    // background: the highlight color if chosen, else Discord's code-block grey
    ctx.fillStyle = bgCss && bgCss !== "transparent" ? bgCss : "#2b2d31";
    ctx.beginPath();
    ctx.roundRect(0, 0, width, height, 14);
    ctx.fill();

    ctx.font = font;
    ctx.textBaseline = "top";
    for (const p of placed) {
        const px = pad + p.x, py = pad + p.line * lineH;
        ctx.fillStyle = fgOverride ?? fgCss(p.fg);
        ctx.fillText(p.t, px, py);
        if (underline && p.t.trim()) {
            ctx.strokeStyle = fgOverride ?? fgCss(p.fg);
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.moveTo(px, py + fontPx + 2);
            ctx.lineTo(px + p.w, py + fontPx + 2);
            ctx.stroke();
        }
    }

    const blob = await new Promise<Blob>((res, rej) => canvas.toBlob(b => (b ? res(b) : rej(new Error("toBlob failed"))), "image/png"));
    return new File([blob], "colored.png", { type: "image/png" });
}

function Swatch({ color, active, title, onClick }: { color: string; active: boolean; title: string; onClick(): void; }) {
    return <button className={`vc-ct-swatch${active ? " vc-ct-active" : ""}`} style={{ background: color }} title={title} aria-label={title} aria-pressed={active} onClick={onClick} />;
}

function Chip({ active, onClick, children, title }: { active?: boolean; onClick(): void; children: React.ReactNode; title?: string; }) {
    return <button className={`vc-ct-chip${active ? " vc-ct-active" : ""}`} aria-pressed={active} title={title} onClick={onClick}>{children}</button>;
}

function ColorPanel({ channelId, close }: { channelId: string; close: () => void; }) {
    const [text, setTextState] = useState(draft);
    const [prefs, setPrefs] = useState<Prefs>(() => ({ ...DEFAULT_PREFS, ...JSON.parse(JSON.stringify(settings.store.prefs ?? {})) }));
    const [imgOpen, setImgOpen] = useState(prefs.customColors || prefs.imgSize !== DEFAULT_PREFS.imgSize);

    const setText = (v: string) => { draft = v; setTextState(v); };
    const set = (patch: Partial<Prefs>) => {
        const next = { ...prefs, ...patch };
        setPrefs(next);
        settings.store.prefs = next;
    };

    const styledText = applyTextStyle(text, prefs.textStyle);
    const { ansi, pieces } = build(styledText || "Your colored text", prefs);
    const bgCss = BG.find(b => b.code === prefs.bg)?.css;
    const limit = messageLimit();
    const empty = !text.trim();
    const tooLong = !empty && ansi.length > limit;
    const usesImageColors = prefs.customColors;

    const finish = () => { setText(""); close(); };

    const sendImage = async () => {
        if (empty) return;
        try {
            const file = await renderImage(
                build(styledText, prefs).pieces,
                prefs.bold, prefs.underline,
                prefs.customColors ? prefs.imgBg : bgCss,
                prefs.imgSize,
                prefs.customColors ? prefs.imgFg : undefined
            );
            UploadHandler.promptToUpload([file], ChannelStore.getChannel(channelId), DraftType.ChannelMessage);
            finish();
            toast("Image added, press Enter to send");
        } catch {
            toast("Couldn't make the image", false);
        }
    };

    const send = () => { if (empty || tooLong) return; sendMessage(channelId, { content: ansi }); finish(); };
    const toBox = () => { if (empty || tooLong) return; insertTextIntoChatInputBox(ansi); finish(); };
    const copy = async () => { if (empty) return; await copyToClipboard(ansi); toast("Copied to clipboard"); };

    return (
        <div className="vc-ct-popout" role="dialog" aria-label="Color text">
            <div className="vc-ct-head">
                <div className="vc-ct-title">Color text</div>
                <button className="vc-ct-link" onClick={() => { set(DEFAULT_PREFS); setText(""); }} title="Clear the text and go back to the default style">Reset</button>
            </div>
            <textarea
                className="vc-ct-input"
                value={text}
                autoFocus
                onChange={e => setText(e.currentTarget.value)}
                onKeyDown={e => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); tooLong ? sendImage() : send(); } }}
                placeholder="Type your text… (Ctrl+Enter sends)"
            />

            <div className="vc-ct-label">Color</div>
            <div className="vc-ct-row">
                {MODES.map(m => <Chip key={m.value} active={prefs.mode === m.value} onClick={() => set({ mode: m.value })}>{m.label}</Chip>)}
                <Chip active={prefs.bold} onClick={() => set({ bold: !prefs.bold })} title="Bold"><b>B</b></Chip>
                <Chip active={prefs.underline} onClick={() => set({ underline: !prefs.underline })} title="Underline"><u>U</u></Chip>
            </div>
            {prefs.mode === "solid" && (
                <div className="vc-ct-row">{FG.map(c => <Swatch key={c.code} color={c.css} title={c.name} active={prefs.fg === c.code} onClick={() => set({ fg: c.code })} />)}</div>
            )}

            <div className="vc-ct-label">Highlight</div>
            <div className="vc-ct-row">
                {BG.map(c => <Swatch key={c.code} color={c.code ? c.css : "repeating-conic-gradient(#555 0 25%, #333 0 50%) 0 0/10px 10px"} title={c.name} active={prefs.bg === c.code} onClick={() => set({ bg: c.code })} />)}
            </div>

            <div className="vc-ct-label">Letters</div>
            <div className="vc-ct-row">
                {TEXT_STYLES.map(s => <Chip key={s.value} active={prefs.textStyle === s.value} onClick={() => set({ textStyle: s.value })}>{s.label}</Chip>)}
            </div>
            <div className="vc-ct-row">
                {CASE_TRANSFORMS.map(c => <Chip key={c.label} onClick={() => setText(c.run(text))} title="Rewrites the text you typed">{c.label}</Chip>)}
            </div>

            <div className="vc-ct-head">
                <div className="vc-ct-label">Preview</div>
                {!empty && <div className={"vc-ct-count" + (tooLong ? " vc-ct-over" : "")}>{ansi.length} / {limit}</div>}
            </div>
            <pre className="vc-ct-preview" style={usesImageColors ? { background: prefs.imgBg } : undefined}>
                {pieces.map((p, i) => (
                    <span key={i} style={{
                        color: usesImageColors ? prefs.imgFg : fgCss(p.fg),
                        background: usesImageColors ? undefined : bgCss,
                        fontWeight: prefs.bold ? 700 : 400,
                        textDecoration: prefs.underline ? "underline" : undefined
                    }}>{p.t}</span>
                ))}
            </pre>
            {usesImageColors && <div className="vc-ct-note">Showing your custom image colors. They only apply to “Send as image”.</div>}
            {tooLong && <div className="vc-ct-note vc-ct-over">Too long to send as text (color codes count toward Discord's limit). Use “Send as image”, or try “Rainbow words” or one color.</div>}

            <button className="vc-ct-disclosure" aria-expanded={imgOpen} onClick={() => setImgOpen(v => !v)}>
                <span>{imgOpen ? "▾" : "▸"} Image options</span>
                <span className="vc-ct-disclosure-hint">only for “Send as image”</span>
            </button>
            {imgOpen && (
                <div className="vc-ct-imgopts">
                    <label className="vc-ct-size">
                        Size
                        <input type="range" min={16} max={44} value={prefs.imgSize} onChange={e => set({ imgSize: Number(e.currentTarget.value) })} />
                        <span>{prefs.imgSize}px</span>
                    </label>
                    <label className="vc-ct-check">
                        <input type="checkbox" checked={prefs.customColors} onChange={e => set({ customColors: e.currentTarget.checked })} />
                        Custom colors (any color, one for all the text)
                    </label>
                    {prefs.customColors && (
                        <div className="vc-ct-row">
                            <label className="vc-ct-colorpick">Text <input type="color" value={prefs.imgFg} onChange={e => set({ imgFg: e.currentTarget.value })} /></label>
                            <label className="vc-ct-colorpick">Background <input type="color" value={prefs.imgBg} onChange={e => set({ imgBg: e.currentTarget.value })} /></label>
                        </div>
                    )}
                </div>
            )}

            <div className="vc-ct-sep" />
            <div className="vc-ct-actions">
                <button className="vc-ct-tool vc-ct-primary" disabled={empty || tooLong} onClick={send}><CtIcon name="send" /><span>Send</span></button>
                <button className="vc-ct-tool" disabled={empty} onClick={sendImage} title="Shows the colors on phones too"><CtIcon name="image" /><span>Send as image</span></button>
                <button className="vc-ct-tool" disabled={empty || tooLong} onClick={toBox}><CtIcon name="box" /><span>To chat box</span></button>
                <button className="vc-ct-tool" disabled={empty} onClick={copy}><CtIcon name="copy" /><span>Copy</span></button>
            </div>
        </div>
    );
}

const CT_ICONS: Record<string, string[]> = {
    send: ["M22 2L11 13", "M22 2l-7 20-4-9-9-4z"],
    image: ["M3 3h18v18H3z", "M8.5 10a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3z", "M21 15l-5-5-9 9"],
    box: ["M4 6h16v12H4z", "M8 10h8M8 14h5"],
    copy: ["M9 9h11v11H9z", "M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"]
};

function CtIcon({ name }: { name: string; }) {
    return (
        <svg viewBox="0 0 24 24" width={18} height={18} fill="none" stroke="currentColor"
            strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            {CT_ICONS[name].map((d, i) => <path key={i} d={d} />)}
        </svg>
    );
}

function PaletteIcon({ height = 22, width = 22, className }: IconProps) {
    return (
        <svg width={width} height={height} viewBox="0 0 24 24" fill="none" stroke="currentColor"
            strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round"
            className={(className ? className + " " : "") + "vc-ct-icon"}>
            <path d="M12 3a9 9 0 0 0 0 18c1 0 1.7-.8 1.7-1.7 0-.5-.2-.9-.5-1.2-.3-.3-.4-.7-.4-1.2 0-1 .8-1.7 1.7-1.7H16a5 5 0 0 0 5-5c0-4-4-7.2-9-7.2z" />
            <path d="M7.5 12h.01M9.5 8h.01M14.5 8h.01M17 12h.01" />
        </svg>
    );
}

const ColorButton: ChatBarButtonFactory = ({ channel }) => {
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
            renderPopout={({ closePopout }) => <ErrorBoundary><ColorPanel channelId={channel.id} close={closePopout} /></ErrorBoundary>}
        >
            {() => (
                <ChatBarButton tooltip="Color text" onClick={() => setShow(v => !v)}>
                    <span ref={buttonRef} className="vc-ct-iconwrap"><PaletteIcon /></span>
                </ChatBarButton>
            )}
        </Popout>
    );
};

export default definePlugin({
    name: "ColorText",
    description: "Write colored / rainbow / unicode-styled text, with case transforms, custom image colors & size, copy, or send as an image",
    authors: [{ name: "you", id: 0n }],
    settings,

    chatBarButton: {
        icon: PaletteIcon,
        render: ColorButton
    }
});
