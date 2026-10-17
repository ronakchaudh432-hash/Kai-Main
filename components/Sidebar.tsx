"use client";

import React, { useRef, useState } from "react";

export interface ConvItem {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
  preview?: string;
}

function dateGroup(d: string): string {
  const now = new Date();
  const date = new Date(d);
  const diff = Math.floor((now.getTime() - date.getTime()) / 86400000);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  if (diff < 7) return 'This week';
  return 'Older';
}

export const Sidebar = React.memo(function Sidebar({
  conversations,
  activeId,
  onSelect,
  onNew,
  onDelete,
  onRename,
  query,
  onQuery,
  open,
  onClose,
  assistantName,
}: {
  conversations: ConvItem[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
  onDelete: (id: string) => void;
  onRename: (id: string, title: string) => void;
  query: string;
  onQuery: (q: string) => void;
  open: boolean;
  onClose: () => void;
  assistantName: string;
}) {
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  // Swipe-to-close for the mobile drawer (leftward swipe past threshold)
  const touchX = useRef<number | null>(null);
  const touchY = useRef<number | null>(null);

  return (
    <>
      <div
        className={`sidebar-backdrop ${open ? "show" : ""}`}
        onClick={onClose}
        aria-hidden="true"
      />
      <aside
        className={`sidebar ${open ? "open" : ""}`}
        aria-label="Conversations"
        onTouchStart={(e) => {
          touchX.current = e.touches[0].clientX;
          touchY.current = e.touches[0].clientY;
        }}
        onTouchEnd={(e) => {
          if (touchX.current === null || touchY.current === null) return;
          const dx = e.changedTouches[0].clientX - touchX.current;
          const dy = e.changedTouches[0].clientY - touchY.current;
          touchX.current = null;
          touchY.current = null;
          if (dx < -60 && Math.abs(dy) < 40) onClose();
        }}
      >
        <button className="new-chat" onClick={() => { onNew(); onClose(); }}>
          <span aria-hidden="true">＋</span> New chat
        </button>
        <div className="side-search">
          <input
            value={query}
            onChange={(e) => onQuery(e.target.value)}
            placeholder="Search chats…"
            aria-label="Search conversations"
          />
        </div>
        <nav className="conv-list">
          {conversations.length === 0 && (
            <p className="conv-empty">No conversations yet.</p>
          )}
          {(() => {
            let lastGroup = "";
            return conversations.map((c) => {
              const group = dateGroup(c.created_at);
              const isNewGroup = group !== lastGroup;
              lastGroup = group;
              return (
                <React.Fragment key={c.id}>
                  {isNewGroup && <div className="conv-date-group">{group}</div>}
                  <div
                    className={`conv-item ${c.id === activeId ? "active" : ""}`}
                    role="button"
                    tabIndex={0}
                    onClick={() => { onSelect(c.id); onClose(); }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") { onSelect(c.id); onClose(); }
                    }}
                    aria-label={`Open conversation ${c.title}`}
                  >
                    <div className="conv-main">
                      {renamingId === c.id ? (
                        <form onSubmit={(e) => { e.preventDefault(); if (renameValue.trim()) { onRename(c.id, renameValue.trim()); } setRenamingId(null); }} className="conv-rename-form">
                          <input
                            value={renameValue}
                            onChange={(e) => setRenameValue(e.target.value)}
                            autoFocus
                            onBlur={() => setRenamingId(null)}
                            onKeyDown={(e) => { if (e.key === 'Escape') setRenamingId(null); }}
                            className="conv-rename-input"
                          />
                        </form>
                      ) : (
                        <>
                          <span className="conv-title">{c.title}</span>
                          {c.preview && <span className="conv-preview">{c.preview}</span>}
                        </>
                      )}
                    </div>
                    {renamingId !== c.id && (
                      <div className="conv-actions">
                        {confirmDeleteId === c.id ? (
                          <div className="conv-confirm">
                            <button onClick={(e) => { e.stopPropagation(); onDelete(c.id); setConfirmDeleteId(null); }} className="confirm-yes">Delete</button>
                            <button onClick={(e) => { e.stopPropagation(); setConfirmDeleteId(null); }} className="confirm-no">Cancel</button>
                          </div>
                        ) : (
                          <>
                            <button
                              aria-label={`Rename ${c.title}`}
                              onClick={(e) => { e.stopPropagation(); setRenamingId(c.id); setRenameValue(c.title); }}
                            >
                              ✎
                            </button>
                            <button
                              aria-label={`Delete ${c.title}`}
                              onClick={(e) => {
                                e.stopPropagation();
                                setConfirmDeleteId(c.id);
                              }}
                            >
                              ×
                            </button>
                          </>
                        )}
                      </div>
                    )}
                  </div>
                </React.Fragment>
              );
            });
          })()}
        </nav>
        <p className="side-foot">{assistantName} · memories stay on this device</p>
      </aside>
    </>
  );
});
