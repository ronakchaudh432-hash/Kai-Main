"use client";

import { useEffect, useRef, useState } from "react";

export function Composer({
  onSend,
  onStop,
  streaming,
  disabled,
  assistantName,
}: {
  onSend: (text: string) => void;
  onStop: () => void;
  streaming: boolean;
  disabled?: boolean;
  assistantName?: string;
}) {
  const [value, setValue] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 180) + "px";
  }, [value]);

  const submit = () => {
    const text = value.trim();
    if (!text || streaming || disabled) return;
    setValue("");
    onSend(text);
    if (window.matchMedia('(pointer: fine)').matches) {
      requestAnimationFrame(() => ref.current?.focus());
    }
  };

  return (
    <form
      className="composer"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <textarea
        ref={ref}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            submit();
          }
        }}
        placeholder={`Message ${assistantName || 'CAI'}…`}
        aria-label="Message input"
        enterKeyHint="send"
        autoComplete="off"
        rows={1}
        disabled={disabled}
      />
      {streaming ? (
        <button type="button" onClick={onStop} className="send-btn stop" aria-label="Stop generation">
          ■
        </button>
      ) : (
        <button
          type="submit"
          className="send-btn"
          disabled={!value.trim() || disabled}
          aria-label="Send message"
        >
          ↑
        </button>
      )}
    </form>
  );
}
