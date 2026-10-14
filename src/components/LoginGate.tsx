import { useState, type FormEvent, type ReactNode } from "react";

/**
 * Barrera de acceso para disuadir visitas casuales al estar la página publicada en un enlace público
 * de GitHub Pages. ESTO NO ES SEGURIDAD REAL: todo el código de esta pantalla (incluido este hash) se
 * descarga entero al navegador de cualquiera que visite el enlace, así que alguien con intención real
 * (ver el código fuente, las herramientas de desarrollador del navegador) puede saltársela. Solo evita
 * que un visitante que llegue por casualidad entre sin querer.
 */
const CREDENTIAL_HASH = "b6528753cfc265b168c720ca0b1a85a4c084bb3d82c30d886b654dc93b18bcae";
const SESSION_KEY = "devstudio:gate-ok";

async function sha256Hex(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function readStored(): boolean {
  try {
    return localStorage.getItem(SESSION_KEY) === "1";
  } catch {
    return false;
  }
}

export function LoginGate({ children }: { children: ReactNode }) {
  const [authed, setAuthed] = useState(readStored);
  const [user, setUser] = useState("");
  const [pass, setPass] = useState("");
  const [error, setError] = useState("");
  const [checking, setChecking] = useState(false);

  if (authed) return <>{children}</>;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setChecking(true);
    setError("");
    try {
      const hash = await sha256Hex(`${user}:${pass}`);
      if (hash === CREDENTIAL_HASH) {
        try {
          localStorage.setItem(SESSION_KEY, "1");
        } catch {
          /* sin almacenamiento: se pedirá de nuevo la próxima vez, no es grave */
        }
        setAuthed(true);
      } else {
        setError("Usuario o contraseña incorrectos.");
      }
    } finally {
      setChecking(false);
    }
  };

  return (
    <div style={{ minHeight: "100dvh", display: "grid", placeItems: "center", background: "#0b0d12", padding: 16 }}>
      <form
        onSubmit={(e) => void submit(e)}
        style={{ width: "100%", maxWidth: 340, display: "grid", gap: 12, background: "#151822", border: "1px solid #262d3d", borderRadius: 14, padding: 24 }}
      >
        <h1 style={{ margin: 0, fontSize: 18, color: "#f2f3f5" }}>Acceso privado</h1>
        <input
          autoFocus
          placeholder="Usuario"
          value={user}
          onChange={(e) => setUser(e.target.value)}
          style={{ height: 40, padding: "0 12px", borderRadius: 8, border: "1px solid #262d3d", background: "#0b0d12", color: "#f2f3f5" }}
        />
        <input
          type="password"
          placeholder="Contraseña"
          value={pass}
          onChange={(e) => setPass(e.target.value)}
          style={{ height: 40, padding: "0 12px", borderRadius: 8, border: "1px solid #262d3d", background: "#0b0d12", color: "#f2f3f5" }}
        />
        {error && <div style={{ color: "#f46a6a", fontSize: 13 }}>{error}</div>}
        <button
          type="submit"
          disabled={checking || !user.trim() || !pass.trim()}
          style={{ height: 40, borderRadius: 8, border: "none", background: "#6c5ce7", color: "#fff", fontWeight: 600, cursor: "pointer", opacity: checking ? 0.6 : 1 }}
        >
          {checking ? "Comprobando…" : "Entrar"}
        </button>
      </form>
    </div>
  );
}
