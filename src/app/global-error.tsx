"use client";

/**
 * Last-resort boundary when the root layout itself fails.
 * Must be fully self-contained (no shared components / fonts).
 */
export default function GlobalError({ reset }: { error: Error; reset: () => void }) {
  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: "100vh",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: "1rem",
          background: "#16130e",
          color: "#f6f2e9",
          fontFamily: "ui-sans-serif, system-ui, sans-serif",
          textAlign: "center",
          padding: "2rem",
        }}
      >
        <p style={{ letterSpacing: "0.25em", fontSize: "11px", color: "#ff4a1c", textTransform: "uppercase" }}>
          Inkline — critical error
        </p>
        <h1 style={{ fontSize: "2rem", fontWeight: 800, textTransform: "uppercase", margin: 0 }}>
          Something broke on our side
        </h1>
        <p style={{ maxWidth: "28rem", color: "#b9b2a4", fontSize: "0.9rem", lineHeight: 1.6 }}>
          We&apos;ve been alerted. Please refresh the page — if it keeps happening, reach us at
          support@inkline.in.
        </p>
        <button
          onClick={reset}
          style={{
            marginTop: "0.5rem",
            borderRadius: "999px",
            border: "1.5px solid #f6f2e9",
            background: "transparent",
            color: "#f6f2e9",
            padding: "0.75rem 1.75rem",
            fontSize: "12px",
            letterSpacing: "0.15em",
            textTransform: "uppercase",
            cursor: "pointer",
          }}
        >
          Reload
        </button>
      </body>
    </html>
  );
}
