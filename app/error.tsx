"use client";

export default function ErrorPage({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div style={{
      display: "flex", flexDirection: "column", alignItems: "center",
      justifyContent: "center", minHeight: "100vh", background: "#0a0a0b",
      color: "#f4f4f5", fontFamily: "system-ui", gap: 16, padding: 24,
    }}>
      <h1 style={{ fontSize: 24, fontWeight: 650 }}>Something went wrong</h1>
      <p style={{ color: "#a1a1aa", maxWidth: 400, textAlign: "center" }}>
        {error.message || "An unexpected error occurred."}
      </p>
      <button
        onClick={reset}
        style={{
          background: "#f4f4f5", color: "#09090b", border: "none",
          borderRadius: 10, padding: "10px 20px", fontWeight: 600,
          cursor: "pointer", fontSize: 14,
        }}
      >
        Try again
      </button>
    </div>
  );
}
