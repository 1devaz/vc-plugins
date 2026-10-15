/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./style.css";

import { ChatBarButton, ChatBarButtonFactory } from "@api/ChatButtons";
import ErrorBoundary from "@components/ErrorBoundary";
import { insertTextIntoChatInputBox, sendMessage } from "@utils/discord";
import definePlugin, { IconProps } from "@utils/types";
import { ChannelStore, DraftType, Popout, showToast, UploadHandler, useRef, useState } from "@webpack/common";

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

const ESC = "\u001b";
const code = (...c: number[]) => `${ESC}[${c.join(";")}m`;

/** returns [ansi text, preview pieces] */
function build(text: string, fg: number, bg: number, bold: boolean, underline: boolean, mode: Mode) {
    const style = [bold ? 1 : 0, ...(underline ? [4] : [])];
    const withBg = (c: number[]) => (bg ? [...c, bg] : c);
    const pieces: { t: string; fg: number; }[] = [];

    if (mode === "solid") pieces.push({ t: text, fg });
    else {
        const parts = mode === "rainbow-letters" ? [...text] : text.split(/(\s+)/);
        let i = 0;
        for (const p of parts) {
            if (!p.trim()) { pieces.push({ t: p, fg }); continue; }
            pieces.push({ t: p, fg: RAINBOW[i++ % RAINBOW.length] });
        }
    }

    const body = pieces.map(p => code(...withBg([...style, p.fg])) + p.t).join("");
    return { ansi: "```ansi\n" + body + code(0) + "\n```", pieces };
}

// ---------- render colored text to an image (so phones see the colors too) ----------

type Piece = { t: string; fg: number; };
const fgCss = (code: number) => FG.find(f => f.code === code)?.css ?? "#ffffff";

/** split pieces into draw parts; each whitespace char (including newlines) becomes its own part */
function splitPieces(pieces: Piece[]) {
    const parts: Piece[] = [];
    for (const p of pieces) {
        for (const part of p.t.split(/(\s)/)) {
            if (part !== "") parts.push({ t: part, fg: p.fg });
        }
    }
    return parts;
}

async function renderImage(pieces: Piece[], bold: boolean, underline: boolean, bgCss: string | undefined): Promise<File> {
    const scale = 2;
    const fontPx = 26, lineH = 38, pad = 22, maxW = 680;
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
        ctx.fillStyle = fgCss(p.fg);
        ctx.fillText(p.t, px, py);
        if (underline && p.t.trim()) {
            ctx.strokeStyle = fgCss(p.fg);
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
    return <button className={`vc-ct-swatch${active ? " vc-ct-active" : ""}`} style={{ background: color }} title={title} onClick={onClick} />;
}

function ColorPanel({ channelId, close }: { channelId: string; close: () => void; }) {
    const [text, setText] = useState("");
    const [fg, setFg] = useState(31);
    const [bg, setBg] = useState(0);
    const [bold, setBold] = useState(true);
    const [underline, setUnderline] = useState(false);
    const [mode, setMode] = useState<Mode>("solid");

    const { ansi, pieces } = build(text || "Your colored text", fg, bg, bold, underline, mode);
    const bgCss = BG.find(b => b.code === bg)?.css;
    const ok = () => { if (!text.trim()) { showToast("Type some text first", "failure"); return false; } return true; };

    const sendImage = async () => {
        if (!ok()) return;
        try {
            const file = await renderImage(build(text, fg, bg, bold, underline, mode).pieces, bold, underline, bgCss);
            UploadHandler.promptToUpload([file], ChannelStore.getChannel(channelId), DraftType.ChannelMessage);
            close();
            showToast("Image added — press Enter to send (shows colors on phone too)", "success");
        } catch (e) {
            showToast("Couldn't make the image", "failure");
        }
    };

    const send = () => { if (!ok()) return; sendMessage(channelId, { content: ansi }); close(); };
    const toBox = () => { if (!ok()) return; insertTextIntoChatInputBox(ansi); close(); };

    return (
        <div className="vc-ct-popout">
            <div className="vc-ct-title">Color text</div>
            <textarea className="vc-ct-input" value={text} autoFocus onChange={e => setText(e.currentTarget.value)} placeholder="Type your text…" />

            <div className="vc-ct-label">Style</div>
            <div className="vc-ct-row">
                {(["solid", "rainbow-words", "rainbow-letters"] as Mode[]).map(m => (
                    <button key={m} className={`vc-ct-chip${mode === m ? " vc-ct-active" : ""}`} onClick={() => setMode(m)}>
                        {m === "solid" ? "One color" : m === "rainbow-words" ? "Rainbow words" : "Rainbow letters"}
                    </button>
                ))}
                <button className={`vc-ct-chip${bold ? " vc-ct-active" : ""}`} onClick={() => setBold(!bold)}><b>B</b></button>
                <button className={`vc-ct-chip${underline ? " vc-ct-active" : ""}`} onClick={() => setUnderline(!underline)}><u>U</u></button>
            </div>

            {mode === "solid" && (
                <>
                    <div className="vc-ct-label">Text color</div>
                    <div className="vc-ct-row">{FG.map(c => <Swatch key={c.code} color={c.css} title={c.name} active={fg === c.code} onClick={() => setFg(c.code)} />)}</div>
                </>
            )}

            <div className="vc-ct-label">Highlight</div>
            <div className="vc-ct-row">
                {BG.map(c => <Swatch key={c.code} color={c.code ? c.css : "repeating-conic-gradient(#555 0 25%, #333 0 50%) 0 0/10px 10px"} title={c.name} active={bg === c.code} onClick={() => setBg(c.code)} />)}
            </div>

            <div className="vc-ct-label">Preview</div>
            <pre className="vc-ct-preview">
                {pieces.map((p, i) => (
                    <span key={i} style={{
                        color: FG.find(f => f.code === p.fg)?.css,
                        background: bgCss,
                        fontWeight: bold ? 700 : 400,
                        textDecoration: underline ? "underline" : undefined
                    }}>{p.t}</span>
                ))}
            </pre>

            <div className="vc-ct-sep" />
            <div className="vc-ct-actions">
                <button className="vc-ct-tool" onClick={send}><CtIcon name="send" /><span>Send</span></button>
                <button className="vc-ct-tool" onClick={sendImage}><CtIcon name="phone" /><span>As image (phone)</span></button>
                <button className="vc-ct-tool" onClick={toBox}><CtIcon name="box" /><span>To chat box</span></button>
            </div>
        </div>
    );
}

const CT_ICONS: Record<string, string[]> = {
    send: ["M22 2L11 13", "M22 2l-7 20-4-9-9-4z"],
    phone: ["M7 2h10a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2z", "M11 18h2"],
    box: ["M4 6h16v12H4z", "M8 10h8M8 14h5"]
};

function CtIcon({ name }: { name: string; }) {
    return (
        <svg viewBox="0 0 24 24" width={18} height={18} fill="none" stroke="currentColor"
            strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
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
    description: "Write colored / rainbow text everyone sees — ANSI for desktop, or send as an image so phones see the colors too",
    authors: [{ name: "you", id: 0n }],

    chatBarButton: {
        icon: PaletteIcon,
        render: ColorButton
    }
});
