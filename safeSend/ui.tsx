/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Black dialog style shared by our plugins (same look as the VC controls popout).
// Drop-in replacements for Discord's Modal / Text / TextInput, plus a confirm dialog.

import "./ui.css";

import { ModalRoot as ModalRootRaw, ModalSize } from "@utils/modal";
import type { RenderModalProps } from "@vencord/discord-types";
import { openModal } from "@webpack/common";
import type { CSSProperties, ReactNode } from "react";

const ModalRoot = ModalRootRaw as any; // typed as never upstream

export interface DialogAction {
    text: string;
    variant?: string; // "primary" | "secondary" | "critical-primary" | "danger"
    onClick(): void;
    disabled?: boolean;
}

interface ModalProps extends RenderModalProps {
    title: ReactNode;
    size?: string;
    actions?: DialogAction[];
    children?: ReactNode;
}

const btnClass = (v?: string) =>
    "vc-bm-btn " + (v === "primary" ? "vc-bm-primary" : v?.includes("critical") || v === "danger" ? "vc-bm-danger" : "vc-bm-secondary");

export function Modal({ title, size, actions, children, ...modalProps }: ModalProps) {
    const wide = size === "md" || size === "lg";
    return (
        <ModalRoot {...modalProps} size={wide ? ModalSize.MEDIUM : ModalSize.SMALL} className="vc-bm-root">
            <div className="vc-bm">
                <div className="vc-bm-head">
                    <div className="vc-bm-title">{title}</div>
                    <button className="vc-bm-x" onClick={modalProps.onClose} aria-label="Close">
                        <svg viewBox="0 0 24 24" width={18} height={18} fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round"><path d="M18 6 6 18M6 6l12 12" /></svg>
                    </button>
                </div>
                <div className="vc-bm-body">{children}</div>
                {actions?.length ? (
                    <div className="vc-bm-actions">
                        {[...actions].reverse().map(a => (
                            <button key={a.text} className={btnClass(a.variant)} disabled={a.disabled} onClick={a.onClick}>{a.text}</button>
                        ))}
                    </div>
                ) : null}
            </div>
        </ModalRoot>
    );
}

export function Text({ variant = "", style, className, children }: { variant?: string; style?: CSSProperties; className?: string; children?: ReactNode; }) {
    const cls = ["vc-bm-text"];
    if (variant.includes("semibold") || variant.includes("bold")) cls.push("vc-bm-strong");
    if (variant.startsWith("text-xs") || variant.startsWith("text-sm")) cls.push("vc-bm-small");
    if (className) cls.push(className);
    return <div className={cls.join(" ")} style={style}>{children}</div>;
}

export function TextInput({ value, onChange, placeholder, autoFocus }: { value: string; onChange(v: string): void; placeholder?: string; autoFocus?: boolean; }) {
    return <input className="vc-bm-input" value={value} placeholder={placeholder} autoFocus={autoFocus} onChange={e => onChange(e.currentTarget.value)} />;
}

/** black confirm dialog. onCancel also runs when it's closed with ×, Esc or a click outside */
export function confirmDialog(o: { title: string; body: ReactNode; confirmText: string; cancelText?: string; danger?: boolean; onConfirm(): void; onCancel?(): void; }) {
    let done = false;
    const finish = (ok: boolean) => {
        if (done) return;
        done = true;
        ok ? o.onConfirm() : o.onCancel?.();
    };
    openModal(p => (
        <Modal
            {...p}
            title={o.title}
            actions={[
                { text: o.confirmText, variant: o.danger ? "danger" : "primary", onClick: () => { finish(true); p.onClose(); } },
                { text: o.cancelText ?? "Cancel", variant: "secondary", onClick: () => { finish(false); p.onClose(); } }
            ]}
        >
            <div className="vc-bm-text">{o.body}</div>
        </Modal>
    ), { onCloseCallback: () => finish(false) } as any);
}
